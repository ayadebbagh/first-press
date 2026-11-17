// A06 / issue #24: durable preparation only. No execution or money movement.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { LedgerDatabase, LedgerTransaction } from './ledger.ts';
import { isPostgresText } from '../../domain/listener-validation.ts';
import { UPDATE_INTERVAL_MS } from '../../domain/backing-policy.ts';

export class BatchError extends Error {
  readonly code: 'invalid' | 'not_found' | 'conflict' | 'ineligible';
  constructor(code: BatchError['code'], message: string) { super(message); this.code = code; }
}
export interface BatchWire {
  id: string;
  artistId: string;
  cutoff: string;
  sealedAt: string;
  eligibleThrough: string;
  status: 'sealed' | 'executed' | 'skipped';
  snapshotId: string | null;
  executedAt: string | null;
  skipReason: string | null;
  membershipSealed: boolean;
  members: { orderId: string; userId: string; artistId: string; ordinal: number }[];
}
type Reader = Pick<LedgerDatabase, 'execute'>;
type Artist = { id: string; status: string; synthetic: boolean };
type Timing = { now: string; future: boolean; expired: boolean; regressed: boolean; eligible: boolean | null };
type SkipReason = 'expired' | 'no_orders' | 'artist_unavailable' | 'review_required' | 'superseded';

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || !isPostgresText(value)) {
    throw new BatchError('invalid', 'Invalid batch, artist or snapshot identifier.');
  }
}
function sealInput(value: { artistId: string; cutoff: Date }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['artistId', 'cutoff'].includes(key))) {
    throw new BatchError('invalid', 'Use artistId and a scheduled cutoff only.');
  }
  identifier(value.artistId);
  if (!(value.cutoff instanceof Date) || !Number.isSafeInteger(value.cutoff.getTime()) || value.cutoff.getTime() < 0 || value.cutoff.getTime() % UPDATE_INTERVAL_MS !== 0) {
    throw new BatchError('invalid', 'Use a valid 00:00 or 12:00 UTC cutoff.');
  }
  return { artistId: value.artistId, cutoff: value.cutoff.toISOString() };
}
async function readBatch(db: Reader, id: string): Promise<BatchWire> {
  // Format on the server: Date hydration would discard PostgreSQL microseconds.
  const result = await db.execute(sql`SELECT id,artist_id,status,snapshot_id,skip_reason,membership_sealed,
    to_char(cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff,
    to_char(sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sealed_at,
    to_char(eligible_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS eligible_through,
    to_char(executed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS executed_at
    FROM settlement_batches WHERE id=${id}`);
  const row = result.rows[0];
  if (!row) throw new BatchError('not_found', 'Settlement batch not found.');
  const members = await db.execute(sql`SELECT order_id,user_id,artist_id,ordinal FROM settlement_batch_orders
    WHERE batch_id=${id} ORDER BY ordinal`);
  return { id: String(row.id), artistId: String(row.artist_id), cutoff: String(row.cutoff), sealedAt: String(row.sealed_at),
    eligibleThrough: String(row.eligible_through), status: row.status as BatchWire['status'],
    snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id),
    executedAt: row.executed_at === null ? null : String(row.executed_at),
    skipReason: row.skip_reason === null ? null : String(row.skip_reason), membershipSealed: row.membership_sealed === true,
    members: members.rows.map(member => ({ orderId: String(member.order_id), userId: String(member.user_id), artistId: String(member.artist_id), ordinal: Number(member.ordinal) })) };
}
async function lockArtist(tx: LedgerTransaction, artistId: string): Promise<Artist> {
  const result = await tx.execute(sql`SELECT id,status,synthetic FROM artists WHERE id=${artistId} FOR UPDATE`);
  const row = result.rows[0];
  if (!row) throw new BatchError('not_found', 'Artist not found.');
  return { id: String(row.id), status: String(row.status), synthetic: row.synthetic === true };
}
async function lockedBatch(tx: LedgerTransaction, id: string) {
  // Discover immutable artist identity without locking a batch before its artist.
  const known = await tx.execute(sql`SELECT artist_id FROM settlement_batches WHERE id=${id}`);
  if (!known.rows[0]) throw new BatchError('not_found', 'Settlement batch not found.');
  const artist = await lockArtist(tx, String(known.rows[0].artist_id));
  await tx.execute(sql`SELECT id FROM settlement_batches WHERE id=${id} FOR UPDATE`);
  return { artist, batch: await readBatch(tx, id) };
}
async function timing(tx: LedgerTransaction, cutoff: string, sealedAt?: string, quote?: { batchId: string; snapshotId: string }): Promise<Timing> {
  // This function is always called AFTER locks. Production has no clock setter.
  const eligible = quote ? sql`public.fp_batch_snapshot_eligible(${quote.batchId},${quote.snapshotId},now)` : sql`NULL::boolean`;
  const result = await tx.execute(sql`WITH instant AS MATERIALIZED (SELECT public.fp_settlement_clock() AS now)
    SELECT to_char(now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now,
      now < ${cutoff}::timestamptz AS future,
      now >= ${cutoff}::timestamptz + interval '2 hours' AS expired,
      now < ${sealedAt ?? cutoff}::timestamptz AS regressed,${eligible} AS eligible FROM instant`);
  return result.rows[0] as unknown as Timing;
}
async function requireServerArtist(tx: LedgerTransaction, artist: Artist) {
  const result = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM database_identity WHERE purpose='demo') AS demo`);
  if (result.rows[0].demo === true || artist.synthetic) throw new BatchError('ineligible', 'Synthetic artists and demo databases cannot prepare server settlement.');
}
async function blockedReason(tx: LedgerTransaction, artist: Artist, cutoff: string): Promise<SkipReason | null> {
  const result = await tx.execute(sql`SELECT
    EXISTS(SELECT 1 FROM settlement_batches WHERE artist_id=${artist.id} AND status='executed' AND cutoff>${cutoff}::timestamptz) AS superseded,
    (EXISTS(SELECT 1 FROM snapshot_annotations a JOIN listener_snapshots s ON s.id=a.snapshot_id
      WHERE s.artist_id=${artist.id} AND a.kind='disputed') OR fp_observation_artist_needs_review(${artist.id})) AS review`);
  if (result.rows[0].superseded === true) return 'superseded';
  if (artist.status !== 'active') return 'artist_unavailable';
  return result.rows[0].review === true ? 'review_required' : null;
}
async function skip(tx: LedgerTransaction, id: string, reason: SkipReason) {
  await tx.execute(sql`UPDATE settlement_batches SET status='skipped',skip_reason=${reason} WHERE id=${id} AND status='sealed'`);
  return readBatch(tx, id);
}

export async function sealSettlementBatch(db: LedgerDatabase, input: { artistId: string; cutoff: Date }): Promise<BatchWire> {
  const ref = sealInput(input);
  return db.transaction(async tx => {
    const artist = await lockArtist(tx, ref.artistId);
    const prior = await tx.execute(sql`SELECT id FROM settlement_batches WHERE artist_id=${ref.artistId} AND cutoff=${ref.cutoff}::timestamptz FOR UPDATE`);
    if (prior.rows[0]) return readBatch(tx, String(prior.rows[0].id));
    const clock = await timing(tx, ref.cutoff);
    if (clock.future) throw new BatchError('invalid', 'A future update cutoff cannot be sealed.');
    await requireServerArtist(tx, artist);
    const reason = clock.expired ? 'expired' : await blockedReason(tx, artist, ref.cutoff);
    const id = randomUUID();
    await tx.execute(sql`INSERT INTO settlement_batches(id,artist_id,cutoff,sealed_at,eligible_through,membership_sealed)
      SELECT ${id},${artist.id},${ref.cutoff}::timestamptz,${clock.now}::timestamptz,
        coalesce(max(accepted_at),${ref.cutoff}::timestamptz-interval '1 microsecond'),false FROM orders
      WHERE artist_id=${artist.id} AND status='queued' AND economy_version='backing-v1'
        AND accepted_at<${ref.cutoff}::timestamptz AND earliest_cutoff<=${ref.cutoff}::timestamptz`);
    await tx.execute(sql`INSERT INTO settlement_batch_orders(batch_id,order_id,user_id,artist_id,ordinal)
      SELECT ${id},id,user_id,artist_id,row_number() OVER(ORDER BY accepted_at,id COLLATE "C")::integer FROM orders
      WHERE artist_id=${artist.id} AND status='queued' AND economy_version='backing-v1'
        AND accepted_at<${ref.cutoff}::timestamptz AND earliest_cutoff<=${ref.cutoff}::timestamptz`);
    await tx.execute(sql`UPDATE settlement_batches SET membership_sealed=true WHERE id=${id}`);
    const batch = await readBatch(tx, id);
    const finalClock = await timing(tx, ref.cutoff, clock.now);
    if (finalClock.regressed) throw new BatchError('ineligible', 'The database clock needs review.');
    const finalReason = finalClock.expired ? 'expired' : reason ?? (batch.members.length === 0 ? 'no_orders' : null);
    return finalReason ? skip(tx, id, finalReason) : batch;
  });
}

// Only this private sentinel is caught; every unexpected write/constraint failure
// rolls back the whole call. An expired attempted bind rolls back its savepoint.
class BindingExpired extends Error {}
function databaseError(error: unknown): { code?: string; constraint?: string } {
  if (!error || typeof error !== 'object') return {};
  const value = error as { code?: string; constraint?: string; cause?: unknown };
  return value.code ? value : value.cause ? databaseError(value.cause) : {};
}
export async function bindBatchSnapshot(db: LedgerDatabase, batchId: string, snapshotId: string): Promise<BatchWire> {
  identifier(batchId); identifier(snapshotId);
  return db.transaction(async tx => {
    const { artist, batch } = await lockedBatch(tx, batchId);
    if (!batch.membershipSealed) throw new BatchError('ineligible', 'A finalized service membership seal is required.');
    if (batch.snapshotId !== null) {
      if (batch.snapshotId !== snapshotId) throw new BatchError('conflict', 'This batch already has a different immutable snapshot.');
      return batch;
    }
    if (batch.status !== 'sealed') return batch;
    const clock = await timing(tx, batch.cutoff, batch.sealedAt);
    if (clock.expired) return skip(tx, batchId, 'expired');
    if (clock.regressed) throw new BatchError('ineligible', 'The database clock precedes the batch seal.');
    await requireServerArtist(tx, artist);
    const reason = await blockedReason(tx, artist, batch.cutoff);
    if (reason) return skip(tx, batchId, reason);
    const quote = await tx.execute(sql`SELECT id FROM listener_snapshots WHERE id=${snapshotId}`);
    if (!quote.rows[0]) throw new BatchError('not_found', 'Listener snapshot not found.');
    const eligibility = await tx.execute(sql`SELECT public.fp_batch_snapshot_eligible(${batchId},${snapshotId},${clock.now}::timestamptz) AS eligible`);
    if (eligibility.rows[0].eligible !== true) throw new BatchError('ineligible', 'This batch requires a new matching accepted C04 observation within its window.');
    try {
      return await tx.transaction(async binding => {
        // Eligibility is checked again by the SQL guard at the actual update.
        await binding.execute(sql`UPDATE settlement_batches SET snapshot_id=${snapshotId} WHERE id=${batchId}`);
        const bound = await readBatch(binding, batchId);
        // Last query before savepoint completion: precise time and source gates
        // use one server sample, after both mutation and result reads.
        const finalClock = await timing(binding, batch.cutoff, batch.sealedAt, { batchId, snapshotId });
        if (finalClock.expired) throw new BindingExpired();
        if (finalClock.regressed) throw new BatchError('ineligible', 'The database clock precedes the batch seal.');
        if (finalClock.eligible !== true) throw new BatchError('ineligible', 'Listener evidence changed eligibility during binding.');
        return bound;
      });
    } catch (error) {
      const failure = databaseError(error);
      if (error instanceof BindingExpired || (failure.code === 'FP001' && failure.constraint === 'batch_binding_expired')) {
        return skip(tx, batchId, 'expired');
      }
      if (failure.code === '23514' && failure.constraint === 'batch_snapshot_eligible') {
        throw new BatchError('ineligible', 'This quote no longer satisfies C04 binding requirements.');
      }
      throw error;
    }
  });
}

export async function expireSettlementBatch(db: LedgerDatabase, batchId: string): Promise<BatchWire> {
  identifier(batchId);
  return db.transaction(async tx => {
    const { batch } = await lockedBatch(tx, batchId);
    if (batch.status !== 'sealed') return batch;
    if (!batch.membershipSealed) throw new BatchError('ineligible', 'Legacy batches have no finalized service membership.');
    const clock = await timing(tx, batch.cutoff, batch.sealedAt);
    if (clock.regressed) throw new BatchError('ineligible', 'The database clock precedes the batch seal.');
    return clock.expired ? skip(tx, batchId, 'expired') : batch;
  });
}
export async function readSettlementBatch(db: LedgerDatabase, batchId: string): Promise<BatchWire> {
  identifier(batchId);
  return db.transaction(tx => readBatch(tx, batchId), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
