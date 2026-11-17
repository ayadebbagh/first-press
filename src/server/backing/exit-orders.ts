import {createHash,randomUUID} from 'node:crypto';
import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import type {LedgerDatabase,LedgerTransaction} from './ledger.ts';
import {lockBackingAccount,walletWire} from './ledger.ts';
import {OrderError,cancelBuy,orderClock,readOwnedOrder,readPositions,requireFreshBaseline,withLedgerErrors} from './buy-orders.ts';
import {ECONOMY_VERSION,exitQuanta,nextUpdateCutoff} from '../../domain/backing-policy.ts';
import {isPostgresText} from '../../domain/listener-validation.ts';

function exitInput(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['artistId','exitBasisPoints','idempotencyKey'].includes(key)))throw new OrderError('invalid','Use artistId, exitBasisPoints and idempotencyKey only.');
  const value=raw as Record<string,unknown>;
  if(typeof value.artistId!=='string'||!value.artistId.trim()||value.artistId.length>200||!isPostgresText(value.artistId)||
    typeof value.exitBasisPoints!=='number'||!Number.isInteger(value.exitBasisPoints)||value.exitBasisPoints<1||value.exitBasisPoints>10000||
    typeof value.idempotencyKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/.test(value.idempotencyKey))throw new OrderError('invalid','Choose an artist, 0.01% to 100% of available backing, and a stable request key.');
  return {artistId:value.artistId,exitBasisPoints:value.exitBasisPoints,idempotencyKey:value.idempotencyKey};
}
// Verify quantity caches before mutating them. The matching deferred database
// guard also rejects incomplete commits; neither layer silently repairs history.
async function assertLotAccounting(tx:LedgerTransaction,lots:typeof schema.positionLots.$inferSelect[]){
  if(!lots.length)return;
  const rows=await tx.execute(sql`SELECT l.id,l.reserved_quanta::numeric=coalesce(sum(a.quanta::numeric) FILTER(WHERE a.status='held'),0) AS holds_match,
    l.remaining_quanta::numeric+coalesce(sum(a.quanta::numeric) FILTER(WHERE a.status='consumed'),0)=l.initial_quanta::numeric AS remaining_match
    FROM position_lots l LEFT JOIN exit_allocations a ON a.lot_id=l.id WHERE l.id IN (${sql.join(lots.map(lot=>sql`${lot.id}`),sql`,`)}) GROUP BY l.id`);
  if(rows.rows.some(row=>row.holds_match!==true||row.remaining_match!==true))throw new OrderError('drift','Backing quantity accounting needs review.');
}
export async function placeExit(db:LedgerDatabase,userId:string,raw:unknown){
  const input=exitInput(raw),hash=createHash('sha256').update(JSON.stringify({version:ECONOMY_VERSION,side:'sell',artistId:input.artistId,exitBasisPoints:input.exitBasisPoints})).digest('hex');
  return withLedgerErrors(()=>db.transaction(async tx=>{
    const [artist]=await tx.select().from(schema.artists).where(eq(schema.artists.id,input.artistId)).for('update');
    const balance=await lockBackingAccount(tx,userId);
    const [prior]=await tx.select().from(schema.orders).where(and(eq(schema.orders.userId,userId),eq(schema.orders.requestKey,input.idempotencyKey)));
    if(prior){
      if(prior.requestHash!==hash)throw new OrderError('conflict','This request key already belongs to a different backing intent.');
      const now=await orderClock(tx);return {order:await readOwnedOrder(tx,userId,prior.id,now),wallet:walletWire(balance),positions:await readPositions(tx,userId,now),created:false};
    }
    let snapshot:typeof schema.listenerSnapshots.$inferSelect,now:Date,lots:typeof schema.positionLots.$inferSelect[],allocations:{lotId:string;quanta:bigint}[];
    try{
      if(!artist)throw new OrderError('not_found','Artist not found.');
      if(artist.status!=='active'||artist.synthetic)throw new OrderError('ineligible','This artist is not accepting new exits.');
      lots=await tx.select().from(schema.positionLots).where(and(eq(schema.positionLots.userId,userId),eq(schema.positionLots.artistId,artist.id))).orderBy(asc(schema.positionLots.id)).for('update');
      await assertLotAccounting(tx,lots);
      now=await orderClock(tx);snapshot=await requireFreshBaseline(tx,artist.id,now);
      allocations=lots.map(lot=>({lotId:lot.id,quanta:exitQuanta(lot.remainingQuanta-lot.reservedQuanta,input.exitBasisPoints)})).filter(allocation=>allocation.quanta>0n);
      if(!allocations.length)throw new OrderError('ineligible','There is no available backing for this exit percentage.');
    }catch(error){if(error instanceof OrderError)error.intentAbsent=true;throw error;}
    const id=randomUUID();
    await tx.insert(schema.orders).values({id,userId,artistId:artist.id,side:'sell',exitBasisPoints:input.exitBasisPoints,requestKey:input.idempotencyKey,requestHash:hash,
      economyVersion:ECONOMY_VERSION,placementSnapshotId:snapshot.id,acceptedAt:now,earliestCutoff:new Date(nextUpdateCutoff(now.getTime()))});
    for(const allocation of allocations){
      await tx.update(schema.positionLots).set({reservedQuanta:sql`${schema.positionLots.reservedQuanta}+${allocation.quanta}`}).where(eq(schema.positionLots.id,allocation.lotId));
      await tx.insert(schema.exitAllocations).values({orderId:id,lotId:allocation.lotId,userId,artistId:artist.id,quanta:allocation.quanta,createdAt:now});
    }
    return {order:await readOwnedOrder(tx,userId,id,now),wallet:walletWire(balance),positions:await readPositions(tx,userId,now),created:true};
  }));
}
export async function cancelExit(db:LedgerDatabase,userId:string,id:string){
  if(typeof id!=='string'||!id||id.length>200||!isPostgresText(id))throw new OrderError('invalid','Invalid order identifier.');
  return withLedgerErrors(()=>db.transaction(async tx=>{
    const [known]=await tx.select({artistId:schema.orders.artistId}).from(schema.orders).where(and(eq(schema.orders.id,id),eq(schema.orders.userId,userId)));
    if(!known)throw new OrderError('not_found','Order not found.');
    await tx.select({id:schema.artists.id}).from(schema.artists).where(eq(schema.artists.id,known.artistId)).for('update');
    const balance=await lockBackingAccount(tx,userId);
    const [order]=await tx.select().from(schema.orders).where(and(eq(schema.orders.id,id),eq(schema.orders.userId,userId))).for('update');
    if(!order||order.side!=='sell')throw new OrderError('not_found','Exit order not found.');
    if(order.status==='settled')throw new OrderError('settled','This exit has settled and cannot be cancelled.');
    if(order.status==='cancelled'){const now=await orderClock(tx);return {order:await readOwnedOrder(tx,userId,id,now),wallet:walletWire(balance),positions:await readPositions(tx,userId,now),cancelled:false};}
    const knownAllocations=await tx.select().from(schema.exitAllocations).where(eq(schema.exitAllocations.orderId,id)).orderBy(asc(schema.exitAllocations.lotId));
    if(!knownAllocations.length)throw new OrderError('drift','This exit has no quantity reservation and needs review.');
    const lots=await tx.select().from(schema.positionLots).where(and(eq(schema.positionLots.userId,userId),eq(schema.positionLots.artistId,order.artistId),inArray(schema.positionLots.id,knownAllocations.map(a=>a.lotId)))).orderBy(asc(schema.positionLots.id)).for('update');
    const allocations=await tx.select().from(schema.exitAllocations).where(eq(schema.exitAllocations.orderId,id)).orderBy(asc(schema.exitAllocations.lotId)).for('update');
    await assertLotAccounting(tx,lots);
    const now=await orderClock(tx);
    const byId=new Map(lots.map(lot=>[lot.id,lot]));
    for(const allocation of allocations){
      const lot=byId.get(allocation.lotId);
      if(!lot||allocation.status!=='held'||allocation.userId!==userId||allocation.artistId!==order.artistId||lot.reservedQuanta<allocation.quanta)throw new OrderError('drift','This exit reservation needs review.');
      await tx.update(schema.positionLots).set({reservedQuanta:sql`${schema.positionLots.reservedQuanta}-${allocation.quanta}`}).where(eq(schema.positionLots.id,lot.id));
      await tx.update(schema.exitAllocations).set({status:'released',resolvedAt:now}).where(and(eq(schema.exitAllocations.orderId,id),eq(schema.exitAllocations.lotId,lot.id)));
    }
    await tx.update(schema.orders).set({status:'cancelled',cancelledAt:now}).where(eq(schema.orders.id,id));
    return {order:await readOwnedOrder(tx,userId,id,now),wallet:walletWire(balance),positions:await readPositions(tx,userId,now),cancelled:true};
  }));
}
export async function cancelOrder(db:LedgerDatabase,userId:string,id:string){
  if(typeof id!=='string'||!id||id.length>200||!isPostgresText(id))throw new OrderError('invalid','Invalid order identifier.');
  const [order]=await db.select({side:schema.orders.side}).from(schema.orders).where(and(eq(schema.orders.id,id),eq(schema.orders.userId,userId)));
  if(!order)throw new OrderError('not_found','Order not found.');
  return order.side==='sell'?cancelExit(db,userId,id):cancelBuy(db,userId,id);
}
