import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.ts';
import { isRecord, isPostgresText, LISTENER_VALIDATION_VERSION, MAX_OBSERVATION_BYTES, observationEnvelope, validateListenerObservation } from '../../domain/listener-validation.ts';

type Database = NodePgDatabase<typeof schema>;
export class ObservationError extends Error {
  readonly code: 'invalid'|'forbidden'|'not_found'|'conflict'|'unavailable';
  constructor(code: ObservationError['code'], message: string) { super(message); this.code=code; }
}
// JSON object property order has no semantic effect on idempotency. Capture times,
// evidence and the original raw count representation do have semantic effect.
function canonical(value: unknown, depth = 0): string {
  if (depth > 12) throw new Error('Observation JSON is too deeply nested.');
  if(typeof value==='string'&&!isPostgresText(value))throw new Error('Observation JSON has unsupported Unicode.');
  if (Array.isArray(value)) return '['+value.map(item=>canonical(item,depth+1)).join(',')+']';
  if (isRecord(value)) return '{'+Object.keys(value).sort().map(key=>canonical(key,depth+1)+':'+canonical(value[key],depth+1)).join(',')+'}';
  return JSON.stringify(value);
}
export function observationResult(row: typeof schema.listenerObservations.$inferSelect, created = false) {
  return { id: row.id, artistId: row.artistId, status: row.status, reasons: row.reasons,
    snapshotId: row.snapshotId, correctsObservationId: row.correctsObservationId,
    validationVersion: row.validationVersion, receivedAt: row.receivedAt.toISOString(), created };
}
export async function submitListenerObservation(db: Database, actorId: string, raw: unknown) {
  // Take an immutable JSON copy. Service callers, like HTTP callers, cannot pass
  // bigint, Date, undefined or prototype-bearing objects as hidden authority.
  let input, hash: string;
  try {
    const encoded = JSON.stringify(raw);
    if (!encoded || Buffer.byteLength(encoded) > MAX_OBSERVATION_BYTES) throw Error();
    input = observationEnvelope(JSON.parse(encoded));
    hash = createHash('sha256').update(canonical(input)).digest('hex');
  } catch { throw new ObservationError('invalid','Use the documented JSON observation envelope (maximum 16 KiB).'); }
  return db.transaction(async tx => {
    // Same admission lock order as backing services. All evidence collection and
    // operator review happens BEFORE this short transaction; no network here.
    const [artist] = await tx.select().from(schema.artists).where(eq(schema.artists.id,input.artistId)).for('update');
    const [member] = await tx.select().from(schema.members).where(eq(schema.members.userId,actorId)).for('update');
    const [user] = await tx.select().from(schema.user).where(eq(schema.user.id,actorId)).for('update');
    if (!user?.emailVerified || member?.role !== 'admin' || member.status !== 'active') throw new ObservationError('forbidden','An active verified admin is required.');
    if (!artist) throw new ObservationError('not_found','Artist not found.');
    const demo = await tx.select().from(schema.databaseIdentity).where(eq(schema.databaseIdentity.purpose,'demo'));
    if (demo.length) throw new ObservationError('unavailable','Demo databases cannot admit backing observations.');
    const [existing] = await tx.select().from(schema.listenerObservations).where(and(eq(schema.listenerObservations.artistId,input.artistId),eq(schema.listenerObservations.sourceEventKey,input.sourceEventKey)));
    if (existing) {
      if (existing.payloadHash !== hash) throw new ObservationError('conflict','This capture key already belongs to a different submission.');
      return observationResult(existing);
    }
    let correction: typeof schema.listenerObservations.$inferSelect | undefined;
    if (input.correctsObservationId) {
      [correction] = await tx.select().from(schema.listenerObservations).where(and(eq(schema.listenerObservations.id,input.correctsObservationId),eq(schema.listenerObservations.artistId,artist.id)));
      if (!correction) throw new ObservationError('not_found','Correction parent not found for this artist.');
    }
    const [previous] = await tx.select().from(schema.listenerSnapshots).where(and(eq(schema.listenerSnapshots.artistId,artist.id),eq(schema.listenerSnapshots.status,'accepted'),eq(schema.listenerSnapshots.synthetic,false))).orderBy(desc(schema.listenerSnapshots.observedAt),desc(schema.listenerSnapshots.acceptedAt)).limit(1);
    const dispute = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM snapshot_annotations a JOIN listener_snapshots s ON s.id=a.snapshot_id
      WHERE s.artist_id=${artist.id} AND a.kind='disputed') OR fp_observation_artist_needs_review(${artist.id}) AS blocked`);
    const ancestry=correction?await tx.execute(sql`SELECT fp_observation_incident_ancestry(${correction.id}) AS blocked`):null;
    // clock_timestamp, rather than transaction start, reflects lock wait time.
    const clock = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    const now = clock.rows[0].now instanceof Date ? clock.rows[0].now : new Date(String(clock.rows[0].now));
    const validation = validateListenerObservation(input,{now,artist,disputed:dispute.rows[0].blocked===true,
      previous:previous?.listenerCount ? {listenerCount:previous.listenerCount,observedAt:previous.observedAt} : undefined,
      correction:correction ? {status:correction.status,reasons:correction.reasons as string[],payload:correction.payload as Record<string,unknown>,incidentBlocked:ancestry?.rows[0].blocked===true} : undefined});
    const id = randomUUID(), snapshotId = validation.status === 'accepted' ? randomUUID() : null;
    if (snapshotId) await tx.insert(schema.listenerSnapshots).values({
      id:snapshotId,artistId:artist.id,status:'accepted',listenerCount:validation.listenerCount,
      provider:'spotify',metric:'monthly_listeners',sourceUrl:input.sourceUrl as string,sourceEventKey:'observation:'+id,
      evidence:{observationId:id,...input.evidence as Record<string,unknown>,validationVersion:LISTENER_VALIDATION_VERSION},
      parserVersion:input.parserVersion as string,observedAt:validation.observedAt!,fetchedAt:validation.fetchedAt!,
      sourceUpdatedAt:validation.sourceUpdatedAt,acceptedAt:now,reviewedBy:actorId,synthetic:false,
    });
    const [row] = await tx.insert(schema.listenerObservations).values({
      id,artistId:artist.id,sourceEventKey:input.sourceEventKey,payloadHash:hash,payload:input,
      status:validation.status,reasons:validation.reasons,validationVersion:LISTENER_VALIDATION_VERSION,
      snapshotId,correctsObservationId:input.correctsObservationId,actorId,receivedAt:now,
    }).returning();
    return observationResult(row,true);
  });
}
