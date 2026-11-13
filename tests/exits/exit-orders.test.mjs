// A05 / issue #23: real PostgreSQL reservation tests. Historical fixture writes
// below exercise guard-valid state transitions, not the future live A06 engine.
import {test as nodeTest,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,symlink,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {and,eq,sql} from 'drizzle-orm';
import * as schema from '../../src/server/db/schema.ts';
import {initializeWallet,lockBackingAccount,postOrderMovement,reconcileWallet} from '../../src/server/backing/ledger.ts';
import {placeBuy,getBackingDesk,getOrder,OrderError} from '../../src/server/backing/buy-orders.ts';
import {placeExit,cancelExit,cancelOrder} from '../../src/server/backing/exit-orders.ts';
import {submitListenerObservation} from '../../src/server/data/listener-observations.ts';
import {nextUpdateCutoff} from '../../src/domain/backing-policy.ts';
import {assertTestDatabase,seedSettledLots,seedHistoricalQuote,nextHistoricalCutoff} from '../helpers/settled-lots.mjs';

const url=process.env.TEST_EXIT_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('Explicit disposable TEST_EXIT_DATABASE_URL ending _test required.');
const applicationName='first-press-exit-orders-test';
const pool=new pg.Pool({connectionString:url,max:28,application_name:applicationName}),db=drizzle(pool,{schema});
const test=(name,action)=>nodeTest(name,{timeout:30_000},action);
const Q=1_000_000_000_000n;
before(async()=>{
  await assertTestDatabase(db);
  const result=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{env:{...process.env,DATABASE_URL:url},encoding:'utf8',timeout:60_000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal((await pool.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n,10);
});
after(async()=>pool.end());
const orderError=code=>error=>error instanceof OrderError&&error.code===code;
const constraintError=error=>(error.code??error.cause?.code)==='23514';
const request=(artistId,exitBasisPoints=10000,idempotencyKey=randomUUID())=>({artistId,exitBasisPoints,idempotencyKey});
const allocations=order=>Object.fromEntries(order.allocations.map(a=>[a.lotId,a.quanta]));

async function member({verified=true,initialized=true,role='member',status='active'}={}){
  const id=randomUUID(),email=id+'@example.invalid';
  await pool.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'a05-exit-test-fixture',now()+interval '1 day')",[email]);
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,\'A05 Exit Test Fixture\',$2,$3)',[id,email,verified]);
  if(role==='admin')await pool.query("UPDATE members SET role='admin' WHERE user_id=$1",[id]);
  if(initialized&&verified)await initializeWallet(db,id);
  if(status!=='active')await pool.query('UPDATE members SET status=$2 WHERE user_id=$1',[id,status]);
  return id;
}
async function artist(admin,{capture=true,count='10000'}={}){
  const id=randomUUID(),spotify=id.replaceAll('-','').slice(0,22);
  await pool.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ($1,$1,'A05 Exit Fixture',$2,'active')",[id,spotify]);
  const input={artistId:id,sourceEventKey:'a05-current-fixture:'+randomUUID(),provider:'spotify',metric:'monthly_listeners',providerArtistId:spotify,listenerCount:count,
    sourceUrl:'https://open.spotify.com/artist/'+spotify,evidence:{reference:'test-fixtures/a05/current/'+id+'.json',sha256:'b'.repeat(64)},
    parserVersion:'a05-current-admin-intake-fixture-v1',observedAt:new Date(Date.now()-600_000).toISOString(),fetchedAt:new Date(Date.now()-599_000).toISOString(),sourceUpdatedAt:null};
  const observation=capture?await submitListenerObservation(db,admin,input):null;
  if(observation)assert.equal(observation.status,'accepted',JSON.stringify(observation));
  return {id,spotify,input,observation,capture:patch=>submitListenerObservation(db,admin,{...input,...patch})};
}
async function fixture({lots=[{principalCents:25000n}],capture=true}={}){
  const admin=await member({role:'admin',initialized:false}),user=await member(),a=await artist(admin,{capture});
  const seeded=lots.length?await seedSettledLots(db,{userId:user,artistId:a.id,adminId:admin,lots}):[];
  return {admin,user,artist:a,lots:seeded,place:(bp=10000,key=randomUUID())=>placeExit(db,user,request(a.id,bp,key))};
}
async function wallet(user,available,reserved=0){
  const report=await reconcileWallet(db,user);assert.equal(report.ok,true,JSON.stringify(report));
  assert.deepEqual(report.wallet,{availableCents:String(available),reservedCents:String(reserved)});return report;
}
async function state(user){
  const {rows:[row]}=await pool.query(`SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM orders x WHERE user_id=$1) orders,
    (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM ledger_events x WHERE user_id=$1) ledger,
    (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.order_id),'[]') FROM cash_reservations x WHERE user_id=$1) cash,
    (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') FROM position_lots x WHERE user_id=$1) lots,
    (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.order_id,x.lot_id),'[]') FROM exit_allocations x WHERE user_id=$1) allocations,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM receipt_events r JOIN position_lots l ON l.id=r.lot_id WHERE l.user_id=$1) receipts,
    (SELECT to_jsonb(w) FROM wallets w WHERE user_id=$1) wallet`,[user]);return row;
}
async function earlyEvidence(user){
  return (await pool.query(`SELECT r.id receipt_id,r.created_at receipt_created_at,l.id lot_id,l.buy_order_id,l.entry_snapshot_id,
    l.principal_cents::text,l.entry_listener_count::text,l.initial_quanta::text,l.created_at,l.economy_version,
    o.accepted_at,o.settled_at,o.placement_snapshot_id,s.observed_at,s.source_url,s.evidence
    FROM receipt_events r JOIN position_lots l ON l.id=r.lot_id JOIN orders o ON o.id=l.buy_order_id
    JOIN listener_snapshots s ON s.id=l.entry_snapshot_id WHERE l.user_id=$1 ORDER BY r.id`,[user])).rows;
}
async function quantities(user){
  const rows=(await pool.query(`SELECT l.id,l.remaining_quanta::text,l.reserved_quanta::text,
    coalesce(sum(a.quanta) FILTER(WHERE a.status='held'),0)::text held,
    coalesce(sum(a.quanta) FILTER(WHERE a.status='consumed'),0)::text consumed
    FROM position_lots l LEFT JOIN exit_allocations a ON a.lot_id=l.id WHERE l.user_id=$1 GROUP BY l.id ORDER BY l.id`,[user])).rows;
  for(const row of rows){assert.equal(row.reserved_quanta,row.held);assert.equal(BigInt(row.remaining_quanta)+BigInt(row.consumed),Q);}
  return rows;
}
async function waitForArtistWaiters(minimum){
  for(let i=0;i<400;i++){
    const {rows:[row]}=await pool.query(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE '%artists%'`,[applicationName]);
    if(row.n>=minimum)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('Expected PostgreSQL artist-lock waiter did not arrive.');
}
async function withArtistLock(f,action){
  const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM artists WHERE id=$1 FOR UPDATE',[f.artist.id]);
  try{return await action();}finally{await lock.query('ROLLBACK');lock.release();}
}

// Historical exits permit cutoff/outage and lock-race tests without altering the
// service clock or placing future quotes ahead of genuine current admin intake.
async function historicalExit(f,quantitiesByLot){
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT id FROM artists WHERE id=${f.artist.id} FOR UPDATE`);
    await lockBackingAccount(tx,f.user);
    const cutoff=await nextHistoricalCutoff(tx,f.artist.id),acceptedAt=new Date(cutoff.getTime()-60_000);
    const quote=await seedHistoricalQuote(tx,{artistId:f.artist.id,adminId:f.admin,observedAt:new Date(cutoff.getTime()-120_000)});
    const id=randomUUID(),raw=request(f.artist.id);
    await tx.insert(schema.orders).values({id,userId:f.user,artistId:f.artist.id,side:'sell',exitBasisPoints:10000,
      requestKey:raw.idempotencyKey,requestHash:createHash('sha256').update(JSON.stringify({version:'backing-v1',side:'sell',artistId:f.artist.id,exitBasisPoints:10000})).digest('hex'),
      placementSnapshotId:quote.id,acceptedAt,earliestCutoff:cutoff});
    const rows=await tx.select().from(schema.positionLots).where(and(eq(schema.positionLots.userId,f.user),eq(schema.positionLots.artistId,f.artist.id))).orderBy(schema.positionLots.id).for('update');
    for(const lot of rows){
      const quanta=quantitiesByLot?BigInt(quantitiesByLot[lot.id]??0):lot.remainingQuanta-lot.reservedQuanta;
      if(quanta===0n)continue;
      assert.ok(quanta>0n&&quanta<=lot.remainingQuanta-lot.reservedQuanta);
      await tx.update(schema.positionLots).set({reservedQuanta:lot.reservedQuanta+quanta}).where(eq(schema.positionLots.id,lot.id));
      await tx.insert(schema.exitAllocations).values({orderId:id,lotId:lot.id,userId:f.user,artistId:f.artist.id,quanta,createdAt:acceptedAt});
    }
    return {id,cutoff,raw};
  });
}
async function settleHistoricalExit(f,id,{locked,commit}={}){
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT id FROM artists WHERE id=${f.artist.id} FOR UPDATE`);
    await lockBackingAccount(tx,f.user);
    const [order]=await tx.select().from(schema.orders).where(eq(schema.orders.id,id)).for('update');
    if(order.status!=='queued')return false;
    const lots=await tx.select().from(schema.positionLots).where(and(eq(schema.positionLots.userId,f.user),eq(schema.positionLots.artistId,f.artist.id))).orderBy(schema.positionLots.id).for('update');
    const held=await tx.select().from(schema.exitAllocations).where(eq(schema.exitAllocations.orderId,id)).orderBy(schema.exitAllocations.lotId).for('update');
    const cutoff=order.earliestCutoff;assert.ok(cutoff.getTime()+5000<Date.now(),'Fixture execution must stay historical.');
    const quote=await seedHistoricalQuote(tx,{artistId:f.artist.id,adminId:f.admin,observedAt:new Date(cutoff.getTime()+2000)});
    const batchId=randomUUID(),executedAt=new Date(cutoff.getTime()+5000);let total=0n;
    await tx.insert(schema.settlementBatches).values({id:batchId,artistId:f.artist.id,cutoff,sealedAt:new Date(cutoff.getTime()+1000),eligibleThrough:new Date(cutoff.getTime()-1)});
    await tx.update(schema.settlementBatches).set({status:'executed',snapshotId:quote.id,executedAt}).where(eq(schema.settlementBatches.id,batchId));
    for(const allocation of held){
      assert.equal(allocation.status,'held');const lot=lots.find(l=>l.id===allocation.lotId);
      const denominator=lot.initialQuanta*lot.entryListenerCount,numerator=lot.principalCents*allocation.quanta*quote.listenerCount+BigInt(lot.proceedsRemainder);
      const proceeds=numerator/denominator,remainder=numerator%denominator,remaining=lot.remainingQuanta-allocation.quanta;total+=proceeds;
      await tx.update(schema.positionLots).set({remainingQuanta:remaining,reservedQuanta:lot.reservedQuanta-allocation.quanta,proceedsRemainder:remaining?String(remainder):'0'}).where(eq(schema.positionLots.id,lot.id));
      await tx.update(schema.exitAllocations).set({status:'consumed',proceedsCents:proceeds,resolvedAt:executedAt}).where(and(eq(schema.exitAllocations.orderId,id),eq(schema.exitAllocations.lotId,lot.id)));
      if(!remaining&&remainder)await tx.insert(schema.roundingEvents).values({id:randomUUID(),orderId:id,lotId:lot.id,retiredNumerator:String(remainder),denominator:String(denominator),createdAt:executedAt});
    }
    await postOrderMovement(tx,f.user,{kind:'sell_settle',orderId:id,amountCents:total,idempotencyKey:'a05-historical-exit-settle:'+id});
    await tx.update(schema.orders).set({status:'settled',settledAt:executedAt}).where(eq(schema.orders.id,id));
    await tx.insert(schema.settlements).values({orderId:id,userId:f.user,artistId:f.artist.id,batchId,executedAt,cashCents:total});
    locked?.();if(commit)await commit;return true;
  });
}

test('settled fixtures preserve chronological past C04 provenance, Credits and distinct early receipts',async()=>{
  const f=await fixture({lots:[{principalCents:10001n},{principalCents:'20003',entryListenerCount:'11000'}]});
  await wallet(f.user,69996);assert.equal((await earlyEvidence(f.user)).length,2);
  const rows=(await pool.query(`SELECT b.cutoff,b.executed_at,s.observed_at,s.accepted_at,c.id capture_id,c.payload->>'parserVersion' parser
    FROM settlement_batches b JOIN listener_snapshots s ON s.id=b.snapshot_id JOIN listener_observations c ON c.snapshot_id=s.id
    WHERE b.artist_id=$1 ORDER BY b.cutoff`,[f.artist.id])).rows;
  assert.equal(rows.length,2);assert.equal(rows[1].cutoff-rows[0].cutoff,43_200_000);
  for(const r of rows){assert.ok(r.cutoff<r.observed_at&&r.observed_at<r.accepted_at&&r.accepted_at<=r.executed_at&&r.executed_at<Date.now());assert.equal(r.parser,'a05-historical-test-fixture-v1');}
  const latest=(await pool.query('SELECT id FROM listener_snapshots WHERE artist_id=$1 ORDER BY observed_at DESC LIMIT 1',[f.artist.id])).rows[0];
  assert.equal(latest.id,f.artist.observation.snapshotId);await quantities(f.user);
  const before=await state(f.user);
  await assert.rejects(seedSettledLots(db,{userId:f.user,artistId:f.artist.id,adminId:f.admin,lots:[{principalCents:'70000'}]}),/exceed available/);
  assert.deepEqual(await state(f.user),before,'An unaffordable fixture cannot leave a partial buy.');
  await assert.rejects(seedHistoricalQuote(db,{artistId:f.artist.id,adminId:f.admin,observedAt:new Date(Date.now()+60_000)}),/past/);
  await assert.rejects(assertTestDatabase({execute:async()=>({rows:[{name:'production'}]})}),/ending _test/);
});

test('queueing a partial exit freezes lot quantities and server times without moving money or receipt evidence',async()=>{
  const f=await fixture({lots:[{principalCents:'25001'},{principalCents:'10001'}]}),before=await state(f.user),evidence=await earlyEvidence(f.user),start=Date.now();
  const result=await f.place(5000),end=Date.now(),o=result.order;
  assert.equal(result.created,true);assert.equal(o.side,'sell');assert.equal(o.status,'queued');assert.equal(o.amountCents,null);assert.equal(o.exitBasisPoints,5000);
  assert.equal(o.estimatedProceedsCents,'17500');assert.equal(o.artistId,f.artist.id);assert.equal(o.economyVersion,'backing-v1');
  assert.deepEqual(o.placement,{snapshotId:f.artist.observation.snapshotId,listenerCount:'10000',observedAt:f.artist.input.observedAt});
  assert.ok(Date.parse(o.acceptedAt)>=start&&Date.parse(o.acceptedAt)<=end);assert.equal(Date.parse(o.earliestCutoff),nextUpdateCutoff(Date.parse(o.acceptedAt)));
  assert.equal(o.cancelledAt,null);assert.equal(o.settledAt,null);assert.equal(o.pendingStatus,'awaiting_update');
  assert.deepEqual(allocations(o),Object.fromEntries(f.lots.map(l=>[l.lotId,'500000000000'])));assert.ok(o.allocations.every(a=>a.status==='held'));
  const after=await state(f.user);for(const field of ['wallet','ledger','cash','receipts'])assert.deepEqual(after[field],before[field]);
  assert.deepEqual(await earlyEvidence(f.user),evidence);await wallet(f.user,64998);
  const position=result.positions.find(p=>p.artistId===f.artist.id);assert.equal(position.lotCount,2);assert.equal(position.reservedLotCount,2);assert.equal(position.availableLotCount,2);
  assert.equal(position.estimatedAvailableCents,'17500');assert.equal(position.canExit,true);assert.equal(position.stale,false);await quantities(f.user);
});

test('minimum fraction and maximum full exit use exact currently available quanta',async()=>{
  const f=await fixture(),minimum=await f.place(1,'min_key1');assert.deepEqual(allocations(minimum.order),{[f.lots[0].lotId]:'100000000'});
  const maximum=await f.place(10000,'Z'.repeat(128));assert.deepEqual(allocations(maximum.order),{[f.lots[0].lotId]:'999900000000'});
  assert.equal(maximum.positions.find(p=>p.artistId===f.artist.id).canExit,false);
  await assert.rejects(f.place(),orderError('ineligible'));await wallet(f.user,75000);await quantities(f.user);
});

test('invalid fractions, keys and client quantity/price/identity/time authority are rejected atomically',async()=>{
  const f=await fixture(),base=request(f.artist.id),before=await state(f.user);
  for(const exitBasisPoints of [undefined,null,false,true,'1','10000',1n,0,-1,0.01,1.1,10001,Number.NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER])
    await assert.rejects(placeExit(db,f.user,{...base,exitBasisPoints}),orderError('invalid'));
  for(const idempotencyKey of ['',null,123,'short77','a'.repeat(129),'éabcdefg','a bcdefg','abcdefg\n','_abcdefg','abcdefgh.','abcdefgh\0'])
    await assert.rejects(placeExit(db,f.user,{...base,idempotencyKey}),orderError('invalid'));
  for(const artistId of ['',null,42,'  ','a'.repeat(201),'bad\0artist','bad\ud800artist'])await assert.rejects(placeExit(db,f.user,{...base,artistId}),orderError('invalid'));
  for(const raw of [null,[],{},'exit',42])await assert.rejects(placeExit(db,f.user,raw),orderError('invalid'));
  for(const [key,value] of Object.entries({amountCents:'100',side:'sell',status:'settled',userId:f.admin,ownerId:f.admin,lotId:f.lots[0].lotId,
    quanta:'1',allocations:[{lotId:f.lots[0].lotId,quanta:'1'}],listenerCount:'1',price:'1',estimatedProceedsCents:'1',placementSnapshotId:f.artist.observation.snapshotId,
    acceptedAt:new Date().toISOString(),earliestCutoff:new Date().toISOString(),now:Date.now()}))
    await assert.rejects(placeExit(db,f.user,{...base,[key]:value}),orderError('invalid'));
  assert.deepEqual(await state(f.user),before);
});

test('owned-lot isolation excludes another member and another artist, including inspection and cancellation',async()=>{
  const f=await fixture(),other=await member(),second=await artist(f.admin);
  const foreign=await seedSettledLots(db,{userId:other,artistId:f.artist.id,adminId:f.admin,lots:[{principalCents:'10000'}]});
  const unrelated=await seedSettledLots(db,{userId:f.user,artistId:second.id,adminId:f.admin,lots:[{principalCents:'10000'}]});
  const result=await f.place();assert.deepEqual(allocations(result.order),{[f.lots[0].lotId]:String(Q)});
  await assert.rejects(cancelExit(db,other,result.order.id),orderError('not_found'));await assert.rejects(cancelOrder(db,other,result.order.id),orderError('not_found'));
  await assert.rejects(getOrder(db,other,result.order.id),orderError('not_found'));
  for(const [user,id] of [[other,foreign[0].lotId],[f.user,unrelated[0].lotId]])assert.equal((await quantities(user)).find(l=>l.id===id).reserved_quanta,'0');
  const desk=await getBackingDesk(db,other);assert.equal(desk.orders.some(o=>o.id===result.order.id),false);assert.equal(desk.positions.some(p=>p.artistId===second.id),false);
});

test('twenty concurrent identical exits freeze one allocation list and never debit Credits',async()=>{
  const f=await fixture(),key=randomUUID(),before=await state(f.user),results=await Promise.all(Array.from({length:20},()=>f.place(4321,key)));
  assert.equal(results.filter(r=>r.created).length,1);assert.equal(new Set(results.map(r=>r.order.id)).size,1);
  for(const r of results){assert.deepEqual(allocations(r.order),{[f.lots[0].lotId]:'432100000000'});assert.deepEqual(r.wallet,{availableCents:'75000',reservedCents:'0'});}
  const after=await state(f.user);assert.equal(after.orders.length,before.orders.length+1);assert.equal(after.allocations.length,1);assert.deepEqual(after.ledger,before.ledger);await quantities(f.user);
});

test('twenty concurrent cancellation retries release each exact held quantity once and preserve early receipts',async()=>{
  const f=await fixture({lots:[{principalCents:'10000'},{principalCents:'15000'}]}),key=randomUUID(),placed=await f.place(3333,key),before=await state(f.user),evidence=await earlyEvidence(f.user);
  const results=await Promise.all(Array.from({length:20},()=>cancelExit(db,f.user,placed.order.id)));
  assert.equal(results.filter(r=>r.cancelled).length,1);
  for(const r of results){assert.equal(r.order.status,'cancelled');assert.equal(r.order.pendingStatus,null);assert.deepEqual(r.wallet,{availableCents:'75000',reservedCents:'0'});assert.ok(r.order.allocations.every(a=>a.status==='released'));assert.deepEqual(allocations(r.order),allocations(placed.order));}
  const replay=await f.place(3333,key);assert.equal(replay.created,false);assert.equal(replay.order.id,placed.order.id);assert.equal(replay.order.status,'cancelled');assert.equal(replay.order.estimatedProceedsCents,placed.order.estimatedProceedsCents);
  const after=await state(f.user);for(const field of ['wallet','ledger','cash','receipts'])assert.deepEqual(after[field],before[field]);
  assert.deepEqual(await earlyEvidence(f.user),evidence);assert.ok((await quantities(f.user)).every(l=>l.reserved_quanta==='0'));await wallet(f.user,75000);
});

test('two concurrent full exits cannot reserve the same available backing twice',async()=>{
  const f=await fixture({lots:[{principalCents:'10000'},{principalCents:'15000'}]});
  const outcomes=await Promise.allSettled([f.place(),f.place()]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(r=>r.status==='rejected'&&orderError('ineligible')(r.reason)).length,1);
  assert.ok((await quantities(f.user)).every(l=>l.reserved_quanta===String(Q)));await wallet(f.user,75000);
});

test('separate accounts may reuse a request key while one account conflicts on changed fraction or artist',async()=>{
  const f=await fixture(),other=await member(),second=await artist(f.admin),key=randomUUID();
  await seedSettledLots(db,{userId:other,artistId:f.artist.id,adminId:f.admin,lots:[{principalCents:'10000'}]});
  const first=await f.place(5000,key);const parallel=await placeExit(db,other,request(f.artist.id,5000,key));assert.notEqual(first.order.id,parallel.order.id);
  await assert.rejects(f.place(5001,key),orderError('conflict'));await assert.rejects(placeExit(db,f.user,request(second.id,5000,key)),orderError('conflict'));
  await assert.rejects(placeExit(db,f.user,request(randomUUID(),5000,key)),orderError('conflict'),'Stored key conflicts before unknown-artist admission checks.');
});

test('same-account cross-artist exit request-key race commits only one intent',async()=>{
  const f=await fixture(),second=await artist(f.admin),key=randomUUID();
  await seedSettledLots(db,{userId:f.user,artistId:second.id,adminId:f.admin,lots:[{principalCents:'10000'}]});
  const outcomes=await Promise.allSettled([f.artist.id,second.id].map(id=>placeExit(db,f.user,request(id,7500,key))));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected'&&orderError('conflict')(r.reason)).length,1);
  assert.deepEqual((await quantities(f.user)).map(l=>l.reserved_quanta).sort(),['0','750000000000']);await wallet(f.user,65000);
});

test('same-account buy/sell request-key races share one namespace on the same or different artists',async()=>{
  for(const differentArtist of [false,true]){
    const f=await fixture(),a=differentArtist?await artist(f.admin):f.artist,key=randomUUID(),before=await state(f.user);
    const outcomes=await Promise.allSettled([f.place(5000,key),placeBuy(db,f.user,{artistId:a.id,amountCents:'10000',idempotencyKey:key})]);
    const winners=outcomes.filter(r=>r.status==='fulfilled');assert.equal(winners.length,1);assert.equal(outcomes.filter(r=>r.status==='rejected'&&orderError('conflict')(r.reason)).length,1);
    const winner=winners[0].value.order,after=await state(f.user);assert.equal(after.orders.length,before.orders.length+1);
    await assert.rejects(winner.side==='buy'?f.place(5000,key):placeBuy(db,f.user,{artistId:a.id,amountCents:'10000',idempotencyKey:key}),orderError('conflict'));
    await wallet(f.user,winner.side==='buy'?65000:75000,winner.side==='buy'?10000:0);await quantities(f.user);
  }
});

test('fractional allocation floors each available lot separately, skips zero lots and rejects an all-zero fraction',async()=>{
  const f=await fixture({lots:[{principalCents:'101'},{principalCents:'103'}]});
  // Leave 3 and 1 available quanta. Aggregating first would incorrectly allocate 2
  // on a half exit; the contract allocates floor(3/2)+floor(1/2)=1.
  const held=await historicalExit(f,{[f.lots[0].lotId]:Q-3n,[f.lots[1].lotId]:Q-1n});
  const half=await f.place(5000);assert.deepEqual(allocations(half.order),{[f.lots[0].lotId]:'1'});assert.equal(half.order.estimatedProceedsCents,'0');
  const before=await state(f.user);await assert.rejects(f.place(1),orderError('ineligible'));assert.deepEqual(await state(f.user),before);
  const full=await f.place();assert.deepEqual(allocations(full.order),{[f.lots[0].lotId]:'2',[f.lots[1].lotId]:'1'});
  await cancelExit(db,f.user,half.order.id);await cancelExit(db,f.user,full.order.id);
  assert.deepEqual((await quantities(f.user)).map(l=>l.reserved_quanta).sort(),[String(Q-3n),String(Q-1n)].sort());
  await cancelExit(db,f.user,held.id);await wallet(f.user,99796);
});

test('new committed lots and new source counts never enlarge or reprice a frozen placement estimate',async()=>{
  const f=await fixture(),key=randomUUID(),placed=await f.place(5000,key),evidence=await earlyEvidence(f.user);
  const [later]=await seedSettledLots(db,{userId:f.user,artistId:f.artist.id,adminId:f.admin,lots:[{principalCents:'10000'}]});
  const newer=await f.artist.capture({sourceEventKey:randomUUID(),listenerCount:'11000',observedAt:new Date(Date.now()-60_000).toISOString(),fetchedAt:new Date(Date.now()-59_000).toISOString()});assert.equal(newer.status,'accepted');
  const saved=await getOrder(db,f.user,placed.order.id),replay=await f.place(5000,key);
  for(const o of [saved,replay.order]){assert.deepEqual(o.placement,placed.order.placement);assert.deepEqual(o.allocations,placed.order.allocations);assert.equal(o.estimatedProceedsCents,'12500');assert.equal(o.acceptedAt,placed.order.acceptedAt);assert.equal(o.earliestCutoff,placed.order.earliestCutoff);}
  assert.equal((await quantities(f.user)).find(l=>l.id===later.lotId).reserved_quanta,'0');
  const desk=await getBackingDesk(db,f.user),position=desk.positions.find(p=>p.artistId===f.artist.id);assert.equal(position.listenerCount,'11000');assert.equal(position.estimatedAvailableCents,'24750');
  await cancelExit(db,f.user,placed.order.id);for(const original of evidence)assert.deepEqual((await earlyEvidence(f.user)).find(r=>r.receipt_id===original.receipt_id),original);
});

test('replay precedes artist suspension/dispute checks and cancelled replays do not allocate again',async()=>{
  const f=await fixture(),key=randomUUID(),placed=await f.place(5000,key);
  await pool.query("UPDATE artists SET status='suspended' WHERE id=$1",[f.artist.id]);
  await pool.query("INSERT INTO snapshot_annotations(id,snapshot_id,kind,reason,actor_id) VALUES ($1,$2,'disputed','A05 fixture source outage',$3)",[randomUUID(),f.artist.observation.snapshotId,f.admin]);
  assert.equal((await f.place(5000,key)).order.id,placed.order.id);await assert.rejects(f.place(5000),orderError('ineligible'));
  assert.equal((await cancelExit(db,f.user,placed.order.id)).cancelled,true);const before=await state(f.user);
  const replay=await f.place(5000,key);assert.equal(replay.created,false);assert.equal(replay.order.status,'cancelled');assert.deepEqual(await state(f.user),before);
});

test('stale baseline and source outage after a past cutoff leave an exit delayed and cancellable',async()=>{
  const f=await fixture({capture:false}),pending=await historicalExit(f),before=await state(f.user);
  const order=await getOrder(db,f.user,pending.id);assert.equal(order.pendingStatus,'delayed');
  await assert.rejects(f.place(),orderError('ineligible'));
  const replay=await placeExit(db,f.user,pending.raw);assert.equal(replay.created,false);assert.equal(replay.order.id,pending.id);
  await pool.query("UPDATE artists SET status='archived' WHERE id=$1",[f.artist.id]);
  const cancelled=await cancelOrder(db,f.user,pending.id);assert.equal(cancelled.cancelled,true);assert.equal(cancelled.order.pendingStatus,null);
  const after=await state(f.user);for(const field of ['wallet','ledger','cash','receipts'])assert.deepEqual(after[field],before[field]);await quantities(f.user);
});

test('new exits require an initialized active verified owner and actual owned available backing',async()=>{
  const f=await fixture({lots:[]}),before=await state(f.user);await assert.rejects(f.place(),orderError('ineligible'));assert.deepEqual(await state(f.user),before);
  for(const options of [{initialized:false},{verified:false},{status:'suspended'}]){
    const user=await member(options);await assert.rejects(placeExit(db,user,request(f.artist.id)),orderError(options.initialized===false?'uninitialized':'ineligible'));
  }
  await assert.rejects(placeExit(db,randomUUID(),request(f.artist.id)),orderError('ineligible'));
  const owned=await fixture();for(const options of [{table:'members',column:'status',value:'suspended',restore:'active'},{table:'"user"',column:'email_verified',value:false,restore:true}]){
    const idColumn=options.table==='members'?'user_id':'id';await pool.query(`UPDATE ${options.table} SET ${options.column}=$2 WHERE ${idColumn}=$1`,[owned.user,options.value]);
    await assert.rejects(owned.place(),orderError('ineligible'));await pool.query(`UPDATE ${options.table} SET ${options.column}=$2 WHERE ${idColumn}=$1`,[owned.user,options.restore]);
  }
});

test('inactive/synthetic artists and latest non-C04 or synthetic snapshots cannot admit exits',async()=>{
  for(const status of ['review','suspended','archived']){const f=await fixture();await pool.query('UPDATE artists SET status=$2 WHERE id=$1',[f.artist.id,status]);await assert.rejects(f.place(),orderError('ineligible'));}
  const synthetic=await fixture();await pool.query('UPDATE artists SET synthetic=true WHERE id=$1',[synthetic.artist.id]);await assert.rejects(synthetic.place(),orderError('ineligible'));
  for(const isSynthetic of [false,true]){
    const f=await fixture(),id=randomUUID(),at=new Date(Date.now()-1000);
    await pool.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by,synthetic)
      VALUES ($1,$2,'accepted',10000,$3,$1,'{"fixture":"unvalidated latest quote"}','a05-unvalidated-fixture',$4,$4,$4,$5,$6)`,[id,f.artist.id,f.artist.input.sourceUrl,at,f.admin,isSynthetic]);
    await assert.rejects(f.place(),orderError('ineligible'));
    assert.equal((await getBackingDesk(db,f.user)).positions.find(p=>p.artistId===f.artist.id).canExit,false);
  }
});

test('a disputed historical entry pauses new exits even when the latest current quote is fresh',async()=>{
  const f=await fixture(),queued=await f.place(2500);
  await pool.query("INSERT INTO snapshot_annotations(id,snapshot_id,kind,reason,actor_id) VALUES ($1,$2,'disputed','A05 historical entry incident',$3)",[randomUUID(),f.lots[0].entrySnapshotId,f.admin]);
  await assert.rejects(f.place(2500),orderError('ineligible'));assert.equal((await cancelExit(db,f.user,queued.order.id)).cancelled,true);await wallet(f.user,75000);
});

test('admission rechecks member revocation after waiting on the artist lock',async()=>{
  const f=await fixture(),before=await state(f.user);let pending;
  await withArtistLock(f,async()=>{pending=f.place();pending.catch(()=>{});await waitForArtistWaiters(1);await pool.query("UPDATE members SET status='suspended' WHERE user_id=$1",[f.user]);});
  await assert.rejects(pending,orderError('ineligible'));assert.deepEqual(await state(f.user),before);
});

test('cancellation rechecks verified ownership after lock wait and keeps all quantities held on revocation',async()=>{
  const f=await fixture(),placed=await f.place(),before=await state(f.user);let pending;
  await withArtistLock(f,async()=>{pending=cancelExit(db,f.user,placed.order.id);pending.catch(()=>{});await waitForArtistWaiters(1);await pool.query('UPDATE "user" SET email_verified=false WHERE id=$1',[f.user]);});
  await assert.rejects(pending,orderError('ineligible'));assert.deepEqual(await state(f.user),before);await quantities(f.user);
});

test('allocation insertion failure rolls back earlier lot reservations and the entire order',async()=>{
  const f=await fixture({lots:[{principalCents:'10000'},{principalCents:'10000'}]}),before=await state(f.user),name='a05_fail_'+randomUUID().replaceAll('-','');
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.user_id='${f.user}' AND EXISTS(SELECT 1 FROM exit_allocations WHERE order_id=NEW.order_id) THEN RAISE EXCEPTION 'A05 fixture second allocation failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER ${name} BEFORE INSERT ON exit_allocations FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{await assert.rejects(f.place());}finally{await pool.query(`DROP TRIGGER ${name} ON exit_allocations; DROP FUNCTION ${name}()`);}
  assert.deepEqual(await state(f.user),before);await quantities(f.user);assert.equal((await f.place()).created,true,'A rolled-back request must not strand reservations.');
});

test('terminal-order cancellation failure rolls back all released quantities and allocations',async()=>{
  const f=await fixture({lots:[{principalCents:'10000'},{principalCents:'10000'}]}),placed=await f.place(5000),before=await state(f.user),name='a05_fail_'+randomUUID().replaceAll('-','');
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${placed.order.id}' AND NEW.status='cancelled' THEN RAISE EXCEPTION 'A05 fixture terminal cancellation failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER ${name} BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{await assert.rejects(cancelExit(db,f.user,placed.order.id));}finally{await pool.query(`DROP TRIGGER ${name} ON orders; DROP FUNCTION ${name}()`);}
  assert.deepEqual(await state(f.user),before);await quantities(f.user);assert.equal((await cancelExit(db,f.user,placed.order.id)).cancelled,true);
});

test('deferred SQL guards reject unmatched reserved/remaining quantities and terminal held allocations',async()=>{
  const f=await fixture(),id=f.lots[0].lotId;
  for(const query of ['UPDATE position_lots SET reserved_quanta=1 WHERE id=$1','UPDATE position_lots SET remaining_quanta=remaining_quanta-1 WHERE id=$1'])
    await assert.rejects(pool.query(query,[id]),constraintError);
  const placed=await f.place(5000),before=await state(f.user);
  await assert.rejects(pool.query("UPDATE exit_allocations SET status='released',resolved_at=clock_timestamp() WHERE order_id=$1",[placed.order.id]),constraintError);
  await assert.rejects(pool.query("UPDATE orders SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1",[placed.order.id]),constraintError);
  await assert.rejects(db.transaction(async tx=>{
    await tx.execute(sql`UPDATE position_lots SET reserved_quanta=0,remaining_quanta=remaining_quanta-500000000000 WHERE id=${id}`);
    await tx.execute(sql`UPDATE exit_allocations SET status='consumed',proceeds_cents=12500,resolved_at=clock_timestamp() WHERE order_id=${placed.order.id}`);
    // A consumed allocation without reducing remaining would violate the other
    // equation even when the reserved cache is correct.
    await tx.execute(sql`UPDATE position_lots SET remaining_quanta=1000000000000 WHERE id=${id}`);
  }),constraintError);
  assert.deepEqual(await state(f.user),before);await quantities(f.user);
});

test('quantity constraints allow transient disagreement inside a complete owning transaction',async()=>{
  const f=await fixture(),placed=await f.place(5000),id=f.lots[0].lotId;
  await db.transaction(async tx=>{
    await tx.execute(sql`UPDATE position_lots SET reserved_quanta=0 WHERE id=${id}`);
    const mismatched=await tx.execute(sql`SELECT reserved_quanta::text AS q FROM position_lots WHERE id=${id}`);assert.equal(mismatched.rows[0].q,'0');
    await tx.execute(sql`UPDATE exit_allocations SET status='released',resolved_at=clock_timestamp() WHERE order_id=${placed.order.id}`);
    await tx.execute(sql`UPDATE orders SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=${placed.order.id}`);
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  });
  assert.equal((await cancelExit(db,f.user,placed.order.id)).cancelled,false);await quantities(f.user);await wallet(f.user,75000);
});

test('owning exit services detect reserved/remaining drift before mutating and leave it for review',async()=>{
  const f=await fixture(),placed=await f.place(5000),before=await state(f.user),abort=Error('rollback deliberate transient drift');
  for(const mutation of ['reserved_quanta=reserved_quanta+1','remaining_quanta=remaining_quanta-1']){
    await assert.rejects(db.transaction(async tx=>{
      await tx.execute(sql.raw('UPDATE position_lots SET '+mutation+" WHERE id='"+f.lots[0].lotId+"'"));
      await assert.rejects(placeExit(tx,f.user,request(f.artist.id,1000)),orderError('drift'));
      await assert.rejects(cancelExit(tx,f.user,placed.order.id),orderError('drift'));throw abort;
    }),error=>error===abort);
    assert.deepEqual(await state(f.user),before);
  }
});

test('settlement winning the artist/order lock race consumes once, retains the early receipt and prevents refund',async()=>{
  const f=await fixture(),pending=await historicalExit(f),evidence=await earlyEvidence(f.user);let reached,release;
  const locked=new Promise(resolve=>{reached=resolve;}),commit=new Promise(resolve=>{release=resolve;});
  const settlement=settleHistoricalExit(f,pending.id,{locked:reached,commit});
  await Promise.race([locked,settlement.then(()=>{throw Error('Settlement missed its lock barrier.');})]);
  const cancellation=cancelExit(db,f.user,pending.id);cancellation.catch(()=>{});let waitError;
  try{await waitForArtistWaiters(1);}catch(error){waitError=error;}finally{release();}
  assert.equal(await settlement,true);await assert.rejects(cancellation,orderError('settled'));await assert.rejects(cancelOrder(db,f.user,pending.id),orderError('settled'));if(waitError)throw waitError;
  const replay=await placeExit(db,f.user,pending.raw);assert.equal(replay.created,false);assert.equal(replay.order.status,'settled');assert.ok(replay.order.allocations.every(a=>a.status==='consumed'));
  assert.equal(await settleHistoricalExit(f,pending.id),false);assert.deepEqual(await earlyEvidence(f.user),evidence);
  const q=await quantities(f.user);assert.equal(q[0].remaining_quanta,'0');assert.equal(q[0].reserved_quanta,'0');assert.equal(q[0].consumed,String(Q));
  assert.equal((await getBackingDesk(db,f.user)).positions.some(p=>p.artistId===f.artist.id),false);await wallet(f.user,100000);
});

test('cancellation winning a queued lock race prevents historical settlement from consuming backing or crediting proceeds',async()=>{
  const f=await fixture(),pending=await historicalExit(f),before=await state(f.user);let cancellation,settlement;
  await withArtistLock(f,async()=>{
    cancellation=cancelExit(db,f.user,pending.id);cancellation.catch(()=>{});await waitForArtistWaiters(1);
    settlement=settleHistoricalExit(f,pending.id);settlement.catch(()=>{});await waitForArtistWaiters(2);
  });
  assert.equal((await cancellation).cancelled,true);assert.equal(await settlement,false);
  const after=await state(f.user);for(const field of ['wallet','ledger','cash','receipts'])assert.deepEqual(after[field],before[field]);
  assert.equal((await quantities(f.user))[0].remaining_quanta,String(Q));await wallet(f.user,75000);
});

test('partially consumed historical lots retain principal/entry evidence and can fully exit subminimum remaining value',async()=>{
  const f=await fixture({lots:[{principalCents:'101'}]}),evidence=await earlyEvidence(f.user),pending=await historicalExit(f,{[f.lots[0].lotId]:Q-1n});
  assert.equal(await settleHistoricalExit(f,pending.id),true);assert.equal((await quantities(f.user))[0].remaining_quanta,'1');
  const full=await f.place();assert.deepEqual(allocations(full.order),{[f.lots[0].lotId]:'1'});assert.equal(full.order.estimatedProceedsCents,'0');
  await cancelExit(db,f.user,full.order.id);assert.deepEqual(await earlyEvidence(f.user),evidence);await wallet(f.user,99999);
});

test('mixed buy/sell desk history paginates without duplicating IDs and generic cancellation dispatches both sides',async()=>{
  const f=await fixture(),ids=new Set(f.lots.map(l=>l.orderId)),before=await state(f.user),evidence=await earlyEvidence(f.user);
  for(let i=0;i<51;i++){
    const placed=i%2?await placeBuy(db,f.user,{artistId:f.artist.id,amountCents:'100',idempotencyKey:randomUUID()}):await f.place(1);
    ids.add(placed.order.id);const cancelled=await cancelOrder(db,f.user,placed.order.id);assert.equal(cancelled.cancelled,true);assert.equal(cancelled.order.side,placed.order.side);
  }
  const seen=[];let cursor,pages=0;
  do{const page=await getBackingDesk(db,f.user,cursor);assert.ok(page.orders.length<=50);seen.push(...page.orders.map(o=>o.id));cursor=page.nextCursor;assert.ok(++pages<=3);}while(cursor);
  assert.equal(seen.length,ids.size);assert.equal(new Set(seen).size,ids.size);assert.deepEqual(new Set(seen),ids);
  const after=await state(f.user);assert.deepEqual(after.receipts,before.receipts);assert.deepEqual(await earlyEvidence(f.user),evidence);await quantities(f.user);await wallet(f.user,75000);
  const buy=await placeBuy(db,f.user,{artistId:f.artist.id,amountCents:'100',idempotencyKey:randomUUID()});
  await assert.rejects(cancelExit(db,f.user,buy.order.id),orderError('not_found'));await cancelOrder(db,f.user,buy.order.id);
  await assert.rejects(cancelExit(db,f.user,randomUUID()),orderError('not_found'));
});

test('standalone getOrder keeps queued/held coherent when cancellation commits between its PostgreSQL reads',async()=>{
  const f=await fixture(),placed=await f.place(5000),events=[];
  const readerPool=new pg.Pool({connectionString:url,max:2,application_name:'first-press-exit-read-coherence-test'});
  let intercepted=false,cancellation;
  readerPool.on('connect',client=>{
    const originalQuery=client.query.bind(client);
    client.query=function(...args){
      const queryText=typeof args[0]==='string'?args[0]:args[0]?.text??'';
      const baseRead=!intercepted&&/from\s+"orders"\s+inner\s+join\s+"artists"/i.test(queryText);
      if(/from\s+"exit_allocations"/i.test(queryText)){
        assert.equal(cancellation?.cancelled,true,'Cancellation must commit before the reader starts its allocation SELECT.');
        events.push('allocation SELECT started');
      }
      if(!baseRead)return originalQuery(...args);
      intercepted=true;
      const afterBaseRead=async result=>{
        assert.equal(result.rowCount,1);events.push('base SELECT completed');
        // Delegate every query to real PostgreSQL. Delay only delivery of the
        // actual base result while a different pool commits cancellation.
        cancellation=await cancelExit(db,f.user,placed.order.id);
        assert.equal(cancellation.cancelled,true);events.push('cancellation committed');
        const committed=(await pool.query(`SELECT o.status,a.status allocation_status,l.reserved_quanta::text
          FROM orders o JOIN exit_allocations a ON a.order_id=o.id JOIN position_lots l ON l.id=a.lot_id WHERE o.id=$1`,[placed.order.id])).rows;
        assert.deepEqual(committed,[{status:'cancelled',allocation_status:'released',reserved_quanta:'0'}]);
        events.push('base result delivered');return result;
      };
      // Transactions use the driver's Promise form. Preserve callback form too,
      // as pool.query uses it for the former nontransactional getOrder path.
      const callback=typeof args.at(-1)==='function'?args.pop():null;
      if(callback)return originalQuery(...args,(error,result)=>{
        if(error){callback(error,result);return;}
        afterBaseRead(result).then(value=>callback(null,value),failure=>callback(failure));
      });
      return originalQuery(...args).then(afterBaseRead);
    };
  });
  try{
    const inFlight=await getOrder(drizzle(readerPool,{schema}),f.user,placed.order.id);
    assert.equal(intercepted,true,'The real base-order SELECT must cross the cancellation barrier.');
    assert.deepEqual(events,['base SELECT completed','cancellation committed','base result delivered','allocation SELECT started']);
    assert.equal(inFlight.status,'queued');assert.equal(inFlight.cancelledAt,null);
    assert.deepEqual(inFlight.allocations,placed.order.allocations,'The earlier snapshot must retain held quantities despite the committed release.');
    const later=await getOrder(db,f.user,placed.order.id);
    assert.equal(later.status,'cancelled');assert.equal(later.cancelledAt,cancellation.order.cancelledAt);
    assert.deepEqual(later.allocations,placed.order.allocations.map(a=>({...a,status:'released'})));
    await quantities(f.user);await wallet(f.user,75000);
  }finally{await readerPool.end();}
});

test('malformed exit and generic cancellation identifiers cannot reach another order or mutate quantities',async()=>{
  const f=await fixture(),placed=await f.place(),before=await state(f.user);
  for(const id of [undefined,null,42,true,[],{},'', 'a'.repeat(201),'bad\0id','bad\ud800id']){
    await assert.rejects(cancelExit(db,f.user,id),orderError('invalid'));
    await assert.rejects(cancelOrder(db,f.user,id),orderError('invalid'));
  }
  assert.deepEqual(await state(f.user),before);await cancelExit(db,f.user,placed.order.id);
});

test('upgrade retains legacy source evidence but blocks new exits on unsafe ancestry; demo classification cannot authorize exits',async()=>{
  // Rehearse real eight-migration legacy storage before the C04 review guard.
  // Do not disable triggers, forge migrations, or rewrite accepted history.
  const root=resolve('.'),temp=await mkdtemp(join(tmpdir(),'firstpress-exit-review-'));
  const name='fp_exit_review_'+randomUUID().replaceAll('-','')+'_test',target=new URL(url);target.pathname='/'+name;
  let other;
  const migrate=cwd=>{const r=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{cwd,env:{...process.env,DATABASE_URL:target.toString()},encoding:'utf8',timeout:60_000});assert.equal(r.status,0,r.stdout+r.stderr);};
  await pool.query(`CREATE DATABASE "${name}"`);
  try{
    await mkdir(join(temp,'drizzle/meta'),{recursive:true});await mkdir(join(temp,'scripts/db'),{recursive:true});await symlink(join(root,'node_modules'),join(temp,'node_modules'));
    const journal=JSON.parse(await readFile('drizzle/meta/_journal.json','utf8'));journal.entries=journal.entries.slice(0,8);
    await writeFile(join(temp,'drizzle/meta/_journal.json'),JSON.stringify(journal));
    for(const entry of journal.entries)await copyFile(join(root,'drizzle',entry.tag+'.sql'),join(temp,'drizzle',entry.tag+'.sql'));
    for(const file of ['migrate.mjs','connection.mjs'])await copyFile(join(root,'scripts/db',file),join(temp,'scripts/db',file));
    await writeFile(join(temp,'drizzle.config.ts'),"export default {dialect:'postgresql',out:'./drizzle',dbCredentials:{url:process.env.DATABASE_URL}};");
    migrate(temp);other=new pg.Pool({connectionString:target.toString(),max:20});const legacy=drizzle(other,{schema});
    const user=randomUUID(),email=user+'@example.invalid',artistId=randomUUID(),spotify=artistId.replaceAll('-','').slice(0,22);
    await other.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'a05-legacy-exit-fixture',now()+interval '1 day')",[email]);
    await other.query('INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,\'A05 Legacy Fixture\',$2,true)',[user,email]);
    await other.query("UPDATE members SET role='admin' WHERE user_id=$1",[user]);
    await other.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ($1,$1,'A05 Legacy Source Fixture',$2,'active')",[artistId,spotify]);
    const [lot]=await seedSettledLots(legacy,{userId:user,artistId,adminId:user,lots:[{principalCents:'10000'}]});
    const now=Date.now();
    async function legacyCapture({status='accepted',parent=null,reasons=[],age=600_000,count='10000'}={}){
      const id=randomUUID(),snapshotId=status==='accepted'?randomUUID():null,receivedAt=new Date(now-1000);
      const payload={artistId,sourceEventKey:'legacy-a05-fixture:'+id,provider:'spotify',metric:'monthly_listeners',providerArtistId:spotify,
        listenerCount:count,sourceUrl:'https://open.spotify.com/artist/'+spotify,evidence:{reference:'test-fixtures/a05/legacy/'+id+'.json',sha256:'c'.repeat(64)},
        parserVersion:'a05-legacy-review-fixture-v1',observedAt:new Date(now-age).toISOString(),fetchedAt:new Date(now-age+1000).toISOString(),sourceUpdatedAt:null,
        ...(parent?{correctsObservationId:parent,reviewReason:'Historical weak C04 review fixture.'}:{})};
      if(snapshotId)await other.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
        VALUES ($1,$2,'accepted',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[snapshotId,artistId,count,payload.sourceUrl,'observation:'+id,
        {...payload.evidence,observationId:id,validationVersion:'spotify-listeners-v2'},payload.parserVersion,payload.observedAt,payload.fetchedAt,receivedAt,user]);
      await other.query(`INSERT INTO listener_observations(id,artist_id,source_event_key,payload_hash,payload,status,reasons,validation_version,snapshot_id,corrects_observation_id,actor_id,received_at)
        VALUES ($1,$2,$3,repeat('c',64),$4,$5,$6,'spotify-listeners-v2',$7,$8,$9,$10)`,[id,artistId,payload.sourceEventKey,payload,status,JSON.stringify(reasons),snapshotId,parent,user,receivedAt]);
      return {id,snapshotId};
    }
    const first=await legacyCapture();
    const pendingId=randomUUID(),acceptedAt=new Date(now),cutoff=new Date(nextUpdateCutoff(now));
    await legacy.transaction(async tx=>{
      await tx.insert(schema.orders).values({id:pendingId,userId:user,artistId,side:'sell',exitBasisPoints:5000,requestKey:randomUUID(),requestHash:'d'.repeat(64),placementSnapshotId:first.snapshotId,acceptedAt,earliestCutoff:cutoff});
      await tx.update(schema.positionLots).set({reservedQuanta:Q/2n}).where(eq(schema.positionLots.id,lot.lotId));
      await tx.insert(schema.exitAllocations).values({orderId:pendingId,lotId:lot.lotId,userId:user,artistId,quanta:Q/2n,createdAt:acceptedAt});
    });
    const blocked=await legacyCapture({status:'quarantined',parent:first.id,reasons:['accepted_correction_requires_incident_review'],age:120_000,count:'11000'});
    await legacyCapture({parent:blocked.id,age:110_000,count:'11000'});
    const preserved=async()=>JSON.stringify({sources:(await other.query('SELECT * FROM listener_snapshots ORDER BY id')).rows,
      observations:(await other.query('SELECT * FROM listener_observations ORDER BY id')).rows,lots:(await other.query('SELECT * FROM position_lots ORDER BY id')).rows,
      receipts:(await other.query('SELECT * FROM receipt_events ORDER BY id')).rows,ledger:(await other.query('SELECT * FROM ledger_events ORDER BY id')).rows});
    const evidence=await preserved();migrate(root);assert.equal(await preserved(),evidence);
    assert.equal((await other.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n,10);
    assert.equal((await other.query('SELECT fp_observation_artist_needs_review($1) blocked',[artistId])).rows[0].blocked,true);
    await assert.rejects(placeExit(legacy,user,request(artistId)),orderError('ineligible'));
    assert.equal((await getBackingDesk(legacy,user)).positions[0].canExit,false);
    assert.equal((await cancelExit(legacy,user,pendingId)).cancelled,true,'Source review must preserve cancellation.');
    assert.equal((await other.query('SELECT reserved_quanta::text q FROM position_lots WHERE id=$1',[lot.lotId])).rows[0].q,'0');
    // Demonstrate otherwise eligible owned backing before classifying this
    // disposable database as demo, so the source incident cannot mask the gate.
    const cleanArtist=randomUUID(),cleanSpotify=cleanArtist.replaceAll('-','').slice(0,22);
    await other.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ($1,$1,'A05 Clean Demo Gate Fixture',$2,'active')",[cleanArtist,cleanSpotify]);
    await seedSettledLots(legacy,{userId:user,artistId:cleanArtist,adminId:user,lots:[{principalCents:'100'}]});
    const capture=await submitListenerObservation(legacy,user,{artistId:cleanArtist,sourceEventKey:randomUUID(),provider:'spotify',metric:'monthly_listeners',
      providerArtistId:cleanSpotify,listenerCount:'10000',sourceUrl:'https://open.spotify.com/artist/'+cleanSpotify,
      evidence:{reference:'test-fixtures/a05/clean-demo-gate.json',sha256:'e'.repeat(64)},parserVersion:'a05-clean-demo-gate-fixture',
      observedAt:new Date(Date.now()-60_000).toISOString(),fetchedAt:new Date(Date.now()-59_000).toISOString(),sourceUpdatedAt:null});
    assert.equal(capture.status,'accepted');assert.equal((await getBackingDesk(legacy,user)).positions.find(p=>p.artistId===cleanArtist).canExit,true);
    const before=(await other.query('SELECT count(*)::int n FROM orders')).rows[0].n;
    await other.query("INSERT INTO database_identity(purpose) VALUES ('demo')");
    await assert.rejects(placeExit(legacy,user,request(cleanArtist)),orderError('ineligible'));
    assert.equal((await other.query('SELECT count(*)::int n FROM orders')).rows[0].n,before);assert.equal((await reconcileWallet(legacy,user)).ok,true);
  }finally{
    if(other)await other.end();await pool.query(`DROP DATABASE "${name}"`);await rm(temp,{recursive:true,force:true});
  }
});
