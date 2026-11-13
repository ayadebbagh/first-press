import { and, eq } from 'drizzle-orm';
import { accountResponse, privateJson, requireAdmin, requireSameOrigin, limitMemberAction, AccessError } from '../../../../server/auth/access';
import { getDatabase } from '../../../../server/db/client';
import { listenerObservations } from '../../../../server/db/schema';
import { ObservationError, observationResult, submitListenerObservation } from '../../../../server/data/listener-observations';
import { MAX_OBSERVATION_BYTES } from '../../../../domain/listener-validation';
export const dynamic = 'force-dynamic';

async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AccessError(415,'Use application/json.');
  const reader = request.body?.getReader();
  if (!reader) throw new AccessError(400,'An observation is required.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OBSERVATION_BYTES) { await reader.cancel(); throw new AccessError(413,'Observation exceeds 16 KiB.'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AccessError(400,'Invalid JSON observation.'); }
  } finally { reader.releaseLock(); }
}
export async function POST(request: Request) {
  return accountResponse(async()=>{
    const {user} = await requireAdmin(request.headers);
    requireSameOrigin(request);
    await limitMemberAction(user.id,'listener-observation-submit',20,60);
    const input = await readBody(request);
    try {
      const result = await submitListenerObservation(getDatabase(),user.id,input);
      return privateJson(result,result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ObservationError) throw new AccessError(
        {invalid:400,forbidden:403,not_found:404,conflict:409,unavailable:503}[error.code],error.message);
      throw error;
    }
  });
}
export async function GET(request: Request) {
  return accountResponse(async()=>{
    const {user} = await requireAdmin(request.headers);
    await limitMemberAction(user.id,'listener-observation-review',30,60);
    const query = new URL(request.url).searchParams, id = query.get('id'), artistId = query.get('artistId');
    if (!id || id.length>200 || !artistId || artistId.length>200) throw new AccessError(400,'Observation id and artistId are required.');
    const [row] = await getDatabase().select().from(listenerObservations).where(and(eq(listenerObservations.id,id),eq(listenerObservations.artistId,artistId)));
    if (!row) return privateJson({error:'Observation not found.'},404);
    return privateJson({...observationResult(row),payload:row.payload,actorId:row.actorId});
  });
}
