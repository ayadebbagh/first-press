import {createHash,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import * as schema from '../../src/server/db/schema.ts';
import {initializeWallet,lockBackingAccount,postOrderMovement} from '../../src/server/backing/ledger.ts';

const SLOT=43_200_000;

// These are explicitly historical database fixtures, not a settlement engine or
// evidence that live A06 settlement works. Never point them at a real account DB.
export async function assertTestDatabase(db){
  const result=await db.execute(sql`SELECT current_database() AS name`);
  if(!String(result.rows[0].name).endsWith('_test'))throw Error('Settled-lot fixtures require current_database() ending _test.');
}

export async function seedHistoricalQuote(tx,{artistId,adminId,listenerCount='10000',observedAt}){
  await assertTestDatabase(tx);
  const observed=new Date(observedAt),fetchedAt=new Date(observed.getTime()+1000),acceptedAt=new Date(observed.getTime()+2000);
  const clock=await tx.execute(sql`SELECT clock_timestamp() AS now`);
  if(!Number.isFinite(observed.getTime())||acceptedAt>=new Date(clock.rows[0].now))throw Error('Historical fixture quotes must remain in the past.');
  const [artist]=await tx.select().from(schema.artists).where(eq(schema.artists.id,artistId));
  if(!artist)throw Error('Fixture artist must already exist.');
  const id=randomUUID(),observationId=randomUUID(),sourceEventKey='a05-historical-fixture:'+observationId;
  const evidence={reference:'test-fixtures/a05/historical/'+observationId+'.json',sha256:createHash('sha256').update(sourceEventKey).digest('hex')};
  const payload={artistId,sourceEventKey,provider:'spotify',metric:'monthly_listeners',providerArtistId:artist.spotifyArtistId,
    listenerCount:String(listenerCount),sourceUrl:'https://open.spotify.com/artist/'+artist.spotifyArtistId,evidence,
    parserVersion:'a05-historical-test-fixture-v1',observedAt:observed.toISOString(),fetchedAt:fetchedAt.toISOString(),sourceUpdatedAt:null};
  await tx.insert(schema.listenerSnapshots).values({id,artistId,status:'accepted',listenerCount:BigInt(listenerCount),
    sourceUrl:payload.sourceUrl,sourceEventKey:'observation:'+observationId,evidence:{...evidence,observationId,validationVersion:'spotify-listeners-v2'},
    parserVersion:payload.parserVersion,observedAt:observed,fetchedAt,acceptedAt,reviewedBy:adminId,synthetic:false});
  await tx.insert(schema.listenerObservations).values({id:observationId,artistId,sourceEventKey,payloadHash:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    payload,status:'accepted',reasons:[],validationVersion:'spotify-listeners-v2',snapshotId:id,actorId:adminId,receivedAt:acceptedAt});
  return {id,observationId,observedAt:observed,acceptedAt,listenerCount:BigInt(listenerCount)};
}

export async function nextHistoricalCutoff(tx,artistId){
  await assertTestDatabase(tx);
  const result=await tx.execute(sql`SELECT clock_timestamp() AS now,max(cutoff) AS latest FROM settlement_batches WHERE artist_id=${artistId}`);
  const now=new Date(result.rows[0].now).getTime(),latest=result.rows[0].latest;
  const cutoff=new Date(latest?new Date(latest).getTime()+SLOT:Math.floor(now/SLOT)*SLOT-16*SLOT);
  if(cutoff.getTime()>=Math.floor(now/SLOT)*SLOT)throw Error('No past chronological fixture slot remains; use a new fixture artist.');
  return cutoff;
}

/** Seed owned settled buys, each in a sequential past batch, in one transaction.
 * The caller creates synthetic test members/artists and a fresh current snapshot
 * through admin intake. Historical sources stay older than that current quote.
 * Returns lot/order/receipt identifiers for service and later real HTTP tests.
 */
export async function seedSettledLots(db,{userId,artistId,adminId,lots=[{principalCents:'25000'}]}){
  await assertTestDatabase(db);
  if(!Array.isArray(lots)||!lots.length)throw Error('At least one settled fixture lot is required.');
  const normalized=lots.map(({principalCents,entryListenerCount='10000'})=>{
    if(!['bigint','string'].includes(typeof principalCents)||!/^[1-9]\d*$/.test(String(principalCents))||BigInt(principalCents)<100n)throw Error('Fixture principal must be integer centi-Credits, at least 100.');
    if(!/^[1-9]\d*$/.test(String(entryListenerCount))||BigInt(entryListenerCount)>1_000_000_000_000n)throw Error('Invalid fixture listener count.');
    return {principalCents:BigInt(principalCents),entryListenerCount:BigInt(entryListenerCount)};
  });
  await initializeWallet(db,userId);
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT id FROM artists WHERE id=${artistId} FOR UPDATE`);
    const balance=await lockBackingAccount(tx,userId);
    if(normalized.reduce((sum,lot)=>sum+lot.principalCents,0n)>balance.availableCents)throw Error('Fixture principals exceed available Credits.');
    const current=await tx.execute(sql`SELECT observed_at FROM listener_snapshots WHERE artist_id=${artistId} AND status='accepted'
      AND parser_version<>'a05-historical-test-fixture-v1' ORDER BY observed_at DESC,accepted_at DESC LIMIT 1`);
    const seeded=[];
    for(const lot of normalized){
      const cutoff=await nextHistoricalCutoff(tx,artistId),acceptedAt=new Date(cutoff.getTime()-60_000);
      if(current.rows[0]&&cutoff.getTime()+2000>=new Date(current.rows[0].observed_at).getTime())throw Error('Historical fixture execution would overtake the current admission snapshot.');
      const baseline=await seedHistoricalQuote(tx,{artistId,adminId,listenerCount:lot.entryListenerCount,observedAt:new Date(cutoff.getTime()-120_000)});
      const quote=await seedHistoricalQuote(tx,{artistId,adminId,listenerCount:lot.entryListenerCount,observedAt:new Date(cutoff.getTime()+2000)});
      const orderId=randomUUID(),lotId=randomUUID(),receiptId=randomUUID(),batchId=randomUUID(),executedAt=new Date(cutoff.getTime()+5000);
      await tx.insert(schema.orders).values({id:orderId,userId,artistId,side:'buy',amountCents:lot.principalCents,
        requestKey:'historical-buy:'+orderId,requestHash:createHash('sha256').update(orderId).digest('hex'),placementSnapshotId:baseline.id,acceptedAt,earliestCutoff:cutoff});
      await postOrderMovement(tx,userId,{kind:'buy_reserve',orderId,amountCents:lot.principalCents,idempotencyKey:'fixture:reserve:'+orderId});
      await tx.insert(schema.cashReservations).values({orderId,userId,artistId,amountCents:lot.principalCents,createdAt:acceptedAt});
      await tx.insert(schema.settlementBatches).values({id:batchId,artistId,cutoff,sealedAt:new Date(cutoff.getTime()+1000),eligibleThrough:new Date(cutoff.getTime()-1)});
      await tx.update(schema.settlementBatches).set({status:'executed',snapshotId:quote.id,executedAt}).where(eq(schema.settlementBatches.id,batchId));
      await postOrderMovement(tx,userId,{kind:'buy_settle',orderId,amountCents:lot.principalCents,idempotencyKey:'fixture:settle:'+orderId});
      await tx.update(schema.cashReservations).set({status:'consumed',resolvedAt:executedAt}).where(eq(schema.cashReservations.orderId,orderId));
      await tx.update(schema.orders).set({status:'settled',settledAt:executedAt}).where(eq(schema.orders.id,orderId));
      await tx.insert(schema.settlements).values({orderId,userId,artistId,batchId,executedAt,cashCents:lot.principalCents});
      await tx.insert(schema.positionLots).values({id:lotId,buyOrderId:orderId,userId,artistId,entrySnapshotId:quote.id,
        principalCents:lot.principalCents,entryListenerCount:lot.entryListenerCount,createdAt:executedAt});
      await tx.insert(schema.receiptEvents).values({id:receiptId,lotId,createdAt:executedAt});
      seeded.push({lotId,orderId,receiptId,batchId,acceptedAt,executedAt,entrySnapshotId:quote.id,...lot});
    }
    return seeded;
  });
}
