import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import { baselineIsFresh, ECONOMY_VERSION, MAX_CENTS, MIN_BACKING_CENTS, nextUpdateCutoff, UPDATE_GRACE_MS } from '../../domain/backing-policy.ts';
import { LedgerError, lockBackingAccount, postOrderMovement, walletWire } from './ledger.ts';
import { isPostgresText } from '../../domain/listener-validation.ts';
import type { LedgerDatabase, LedgerTransaction } from './ledger.ts';

export class OrderError extends Error {
  readonly code: 'invalid'|'not_found'|'ineligible'|'uninitialized'|'insufficient'|'conflict'|'settled'|'drift';
  intentAbsent=false;
  constructor(code: OrderError['code'],message: string){super(message);this.code=code;}
}
type Reader=Pick<LedgerDatabase,'select'|'execute'>;
type StoredOrder=typeof schema.orders.$inferSelect;
type Snapshot=typeof schema.listenerSnapshots.$inferSelect;
export interface OrderWire {
  id:string;artistId:string;artistName:string;side:'buy'|'sell';status:StoredOrder['status'];amountCents:string|null;
  acceptedAt:string;earliestCutoff:string;cancelledAt:string|null;settledAt:string|null;economyVersion:string;
  placement:{snapshotId:string;listenerCount:string;observedAt:string};pendingStatus:'awaiting_update'|'delayed'|null;
}
function wire(order:StoredOrder,artistName:string,snapshot:Snapshot,now:Date):OrderWire {
  return {id:order.id,artistId:order.artistId,artistName,side:order.side,status:order.status,amountCents:order.amountCents?.toString()??null,
    acceptedAt:order.acceptedAt.toISOString(),earliestCutoff:order.earliestCutoff.toISOString(),cancelledAt:order.cancelledAt?.toISOString()??null,
    settledAt:order.settledAt?.toISOString()??null,economyVersion:order.economyVersion,
    placement:{snapshotId:snapshot.id,listenerCount:snapshot.listenerCount!.toString(),observedAt:snapshot.observedAt.toISOString()},
    pendingStatus:order.status==='queued'?(now.getTime()>=order.earliestCutoff.getTime()+UPDATE_GRACE_MS?'delayed':'awaiting_update'):null};
}
async function clock(db:Reader){
  const result=await db.execute(sql`SELECT clock_timestamp() AS now`),value=result.rows[0].now;
  return value instanceof Date?value:new Date(String(value));
}
function buyInput(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['artistId','amountCents','idempotencyKey'].includes(k)))throw new OrderError('invalid','Use artistId, amountCents and idempotencyKey only.');
  const value=raw as Record<string,unknown>;
  if(typeof value.artistId!=='string'||!value.artistId.trim()||value.artistId.length>200||!isPostgresText(value.artistId)||typeof value.amountCents!=='string'||!/^[1-9]\d{0,18}$/.test(value.amountCents)||
    typeof value.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(value.idempotencyKey))throw new OrderError('invalid','Invalid artist, integer centi-Credit amount or request key.');
  const amount=BigInt(value.amountCents);
  if(amount<MIN_BACKING_CENTS||amount>MAX_CENTS)throw new OrderError('invalid','Backing must be at least 1 Credit and within the supported range.');
  return {artistId:value.artistId,amountCents:amount,idempotencyKey:value.idempotencyKey};
}
async function translated<T>(action:()=>Promise<T>):Promise<T>{
  try{return await action();}catch(error){
    if(error instanceof LedgerError){
      const code=error.code==='overflow'?'invalid':error.code;
      throw new OrderError(code,error.message);
    }
    throw error;
  }
}
const orderSelection={order:schema.orders,artistName:schema.artists.name,snapshot:schema.listenerSnapshots};
async function ownedOrder(db:Reader,userId:string,id:string,now:Date){
  const [row]=await db.select(orderSelection).from(schema.orders).innerJoin(schema.artists,eq(schema.artists.id,schema.orders.artistId))
    .innerJoin(schema.listenerSnapshots,eq(schema.listenerSnapshots.id,schema.orders.placementSnapshotId))
    .where(and(eq(schema.orders.id,id),eq(schema.orders.userId,userId)));
  if(!row)throw new OrderError('not_found','Order not found.');
  return wire(row.order,row.artistName,row.snapshot,now);
}
async function hasDispute(tx:Reader,artistId:string){
  const result=await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM snapshot_annotations a JOIN listener_snapshots s ON s.id=a.snapshot_id
    WHERE s.artist_id=${artistId} AND a.kind='disputed') OR fp_observation_artist_needs_review(${artistId}) AS blocked`);
  return result.rows[0].blocked===true;
}
async function latestBaseline(tx:LedgerTransaction,artistId:string,now:Date){
  const [snapshot]=await tx.select().from(schema.listenerSnapshots).where(and(eq(schema.listenerSnapshots.artistId,artistId),eq(schema.listenerSnapshots.status,'accepted')))
    .orderBy(desc(schema.listenerSnapshots.observedAt),desc(schema.listenerSnapshots.acceptedAt)).limit(1);
  if(!snapshot||snapshot.synthetic||!snapshot.listenerCount||!snapshot.acceptedAt||snapshot.acceptedAt>now||!baselineIsFresh(snapshot.observedAt.getTime(),now.getTime()))throw new OrderError('ineligible','This artist needs a fresh reviewed listener update before new backing.');
  const [capture]=await tx.select({id:schema.listenerObservations.id}).from(schema.listenerObservations).where(and(eq(schema.listenerObservations.snapshotId,snapshot.id),eq(schema.listenerObservations.status,'accepted')));
  if(!capture||await hasDispute(tx,artistId))throw new OrderError('ineligible','This artist needs listener-data review before new backing.');
  return snapshot;
}
export async function placeBuy(db:LedgerDatabase,userId:string,raw:unknown){
  const input=buyInput(raw),hash=createHash('sha256').update(JSON.stringify({version:ECONOMY_VERSION,side:'buy',artistId:input.artistId,amountCents:input.amountCents.toString()})).digest('hex');
  return translated(()=>db.transaction(async tx=>{
    // Shared admission lock with listener intake and future batch sealing.
    const [artist]=await tx.select().from(schema.artists).where(eq(schema.artists.id,input.artistId)).for('update');
    const balance=await lockBackingAccount(tx,userId);
    const [prior]=await tx.select().from(schema.orders).where(and(eq(schema.orders.userId,userId),eq(schema.orders.requestKey,input.idempotencyKey)));
    // Replays preserve the committed result even if artist/data availability has
    // changed. Account authorization is still checked on every request.
    if(prior){
      if(prior.requestHash!==hash)throw new OrderError('conflict','This request key already belongs to a different backing intent.');
      return {order:await ownedOrder(tx,userId,prior.id,await clock(tx)),wallet:walletWire(balance),created:false};
    }
    let now:Date,snapshot:Snapshot;
    try{
      if(!artist)throw new OrderError('not_found','Artist not found.');
      if(artist.status!=='active'||artist.synthetic)throw new OrderError('ineligible','This artist is not accepting new backing.');
      now=await clock(tx);snapshot=await latestBaseline(tx,artist.id,now);
      if(input.amountCents>balance.availableCents)throw new OrderError('insufficient','Not enough available Credits.');
    }catch(error){
      // Account-wide admission serialization proved this key has no committed
      // order. A client recovering an ambiguous response may safely change intent.
      if(error instanceof OrderError)error.intentAbsent=true;
      throw error;
    }
    const [order]=await tx.insert(schema.orders).values({id:randomUUID(),userId,artistId:artist.id,side:'buy',amountCents:input.amountCents,
      requestKey:input.idempotencyKey,requestHash:hash,placementSnapshotId:snapshot.id,acceptedAt:now,earliestCutoff:new Date(nextUpdateCutoff(now.getTime())),economyVersion:ECONOMY_VERSION}).returning();
    const posted=await postOrderMovement(tx,userId,{kind:'buy_reserve',orderId:order.id,amountCents:input.amountCents,idempotencyKey:'buy:reserve:'+order.id});
    await tx.insert(schema.cashReservations).values({orderId:order.id,userId,artistId:artist.id,amountCents:input.amountCents,createdAt:now});
    return {order:wire(order,artist.name,snapshot,now),wallet:walletWire(posted.wallet),created:true};
  }));
}
export async function cancelBuy(db:LedgerDatabase,userId:string,id:string){
  if(typeof id!=='string'||!id||id.length>200||!isPostgresText(id))throw new OrderError('invalid','Invalid order identifier.');
  return translated(()=>db.transaction(async tx=>{
    // Discover ownership without locking the order before the wallet. The artist
    // and all order intent fields are immutable; re-read after canonical locks.
    const [known]=await tx.select({artistId:schema.orders.artistId}).from(schema.orders).where(and(eq(schema.orders.id,id),eq(schema.orders.userId,userId)));
    if(!known)throw new OrderError('not_found','Order not found.');
    await tx.select({id:schema.artists.id}).from(schema.artists).where(eq(schema.artists.id,known.artistId)).for('update');
    const balance=await lockBackingAccount(tx,userId);
    const [order]=await tx.select().from(schema.orders).where(and(eq(schema.orders.id,id),eq(schema.orders.userId,userId))).for('update');
    if(!order||order.side!=='buy')throw new OrderError('not_found','Buy order not found.');
    const now=await clock(tx);
    if(order.status==='settled')throw new OrderError('settled','This order has settled and cannot be cancelled.');
    if(order.status==='cancelled')return {order:await ownedOrder(tx,userId,id,now),wallet:walletWire(balance),cancelled:false};
    const [hold]=await tx.select().from(schema.cashReservations).where(eq(schema.cashReservations.orderId,id)).for('update');
    if(!hold||hold.status!=='held'||hold.amountCents!==order.amountCents||hold.userId!==userId||hold.artistId!==order.artistId)throw new OrderError('drift','This backing reservation needs review.');
    const posted=await postOrderMovement(tx,userId,{kind:'buy_cancel',orderId:id,amountCents:hold.amountCents,idempotencyKey:'buy:cancel:'+id});
    await tx.update(schema.cashReservations).set({status:'released',resolvedAt:now}).where(eq(schema.cashReservations.orderId,id));
    await tx.update(schema.orders).set({status:'cancelled',cancelledAt:now}).where(eq(schema.orders.id,id));
    return {order:await ownedOrder(tx,userId,id,now),wallet:walletWire(posted.wallet),cancelled:true};
  }));
}
export async function getOrder(db:Reader,userId:string,id:string){if(!id||id.length>200||!isPostgresText(id))throw new OrderError('invalid','Invalid order identifier.');return ownedOrder(db,userId,id,await clock(db));}

function decodeCursor(value?:string){
  if(value===undefined)return null;
  try{
    if(value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
    const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if(!Array.isArray(parsed)||parsed.length!==2||typeof parsed[0]!=='string'||typeof parsed[1]!=='string'||!parsed[1]||parsed[1].length>200||!isPostgresText(parsed[1]))throw Error();
    const at=new Date(parsed[0]);if(at.toISOString()!==parsed[0])throw Error();
    return {at,id:parsed[1]};
  }catch{throw new OrderError('invalid','Invalid order history cursor.');}
}
export async function getBackingDesk(db:LedgerDatabase,userId:string,cursor?:string){
  const after=decodeCursor(cursor);
  return db.transaction(async tx=>{
    const now=await clock(tx);
    const [balance]=await tx.select().from(schema.wallets).where(eq(schema.wallets.userId,userId));
    const eligible=await tx.execute(sql`SELECT a.id,a.name,s.listener_count::text,s.observed_at FROM artists a
      JOIN LATERAL (SELECT * FROM listener_snapshots WHERE artist_id=a.id AND status='accepted' ORDER BY observed_at DESC,accepted_at DESC LIMIT 1) s ON true
      JOIN listener_observations c ON c.snapshot_id=s.id AND c.status='accepted'
      WHERE a.status='active' AND NOT a.synthetic AND NOT s.synthetic AND s.observed_at<=${now.toISOString()}::timestamptz AND s.accepted_at<=${now.toISOString()}::timestamptz AND s.observed_at>=${now.toISOString()}::timestamptz-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM snapshot_annotations n JOIN listener_snapshots q ON q.id=n.snapshot_id WHERE q.artist_id=a.id AND n.kind='disputed')
      AND NOT fp_observation_artist_needs_review(a.id)
      ORDER BY a.name,a.id LIMIT 1000`);
    const condition=after?and(eq(schema.orders.userId,userId),eq(schema.orders.side,'buy'),sql`(${schema.orders.acceptedAt},${schema.orders.id}) < (${after.at},${after.id})`):and(eq(schema.orders.userId,userId),eq(schema.orders.side,'buy'));
    const rows=await tx.select(orderSelection).from(schema.orders).innerJoin(schema.artists,eq(schema.artists.id,schema.orders.artistId))
      .innerJoin(schema.listenerSnapshots,eq(schema.listenerSnapshots.id,schema.orders.placementSnapshotId))
      .where(condition).orderBy(desc(schema.orders.acceptedAt),desc(schema.orders.id)).limit(51);
    const page=rows.slice(0,50),last=page.at(-1)?.order;
    return {wallet:balance?walletWire(balance):null,artists:eligible.rows.map(a=>({id:String(a.id),name:String(a.name),listenerCount:String(a.listener_count),observedAt:(a.observed_at instanceof Date?a.observed_at:new Date(String(a.observed_at))).toISOString()})),
      orders:page.map(row=>wire(row.order,row.artistName,row.snapshot,now)),nextCursor:rows.length>50&&last?Buffer.from(JSON.stringify([last.acceptedAt.toISOString(),last.id])).toString('base64url'):null,serverTime:now.toISOString()};
  },{isolationLevel:'repeatable read',accessMode:'read only'});
}
