import {test as nodeTest,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql,eq} from 'drizzle-orm';
import * as schema from '../../src/server/db/schema.ts';
import {initializeWallet,postOrderMovement,reconcileWallet} from '../../src/server/backing/ledger.ts';
import {submitListenerObservation} from '../../src/server/data/listener-observations.ts';
import {placeBuy,cancelBuy,getBackingDesk,OrderError} from '../../src/server/backing/buy-orders.ts';
import {MAX_CENTS,nextUpdateCutoff} from '../../src/domain/backing-policy.ts';

const url=process.env.TEST_ORDER_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('Explicit disposable TEST_ORDER_DATABASE_URL ending _test required.');
const pool=new pg.Pool({connectionString:url,max:28,application_name:'first-press-buy-orders-test'}),db=drizzle(pool,{schema});
const test=(name,action)=>nodeTest(name,{timeout:30000},action);
before(()=>{const result=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{env:{...process.env,DATABASE_URL:url},encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stdout+result.stderr);});
after(async()=>pool.end());
const orderError=code=>error=>error instanceof OrderError&&error.code===code;
const anyOrderError=error=>error instanceof OrderError;
const request=(artistId,amountCents='25000',idempotencyKey=randomUUID())=>({artistId,amountCents,idempotencyKey});

async function member({verified=true,initialized=true,role='member',status='active'}={}){
  const id=randomUUID(),email=id+'@example.invalid';
  await pool.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'buy-order-fixture',now()+interval '1 day')",[email]);
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,\'Buy Fixture\',$2,$3)',[id,email,verified]);
  if(role==='admin')await pool.query("UPDATE members SET role='admin' WHERE user_id=$1",[id]);
  if(initialized&&verified)await initializeWallet(db,id);
  if(status!=='active')await pool.query('UPDATE members SET status=$2 WHERE user_id=$1',[id,status]);
  return id;
}
async function artist(admin,{capture=true,age=600000,count='10000'}={}){
  const id=randomUUID(),spotify=id.replaceAll('-','').slice(0,22);
  await pool.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ($1,$1,'Order Fixture',$2,'active')",[id,spotify]);
  const input={artistId:id,sourceEventKey:randomUUID(),provider:'spotify',metric:'monthly_listeners',providerArtistId:spotify,listenerCount:count,
    sourceUrl:'https://open.spotify.com/artist/'+spotify,evidence:{reference:'fixture/'+id+'.png',sha256:'a'.repeat(64)},parserVersion:'manual-order-fixture-v1',
    observedAt:new Date(Date.now()-age).toISOString(),fetchedAt:new Date(Date.now()-age+1000).toISOString(),sourceUpdatedAt:null};
  const observation=capture?await submitListenerObservation(db,admin,input):null;
  if(observation)assert.equal(observation.status,'accepted');
  return {id,spotify,input,observation,capture:patch=>submitListenerObservation(db,admin,{...input,...patch})};
}
async function fixture(options={}){
  const admin=await member({role:'admin',initialized:false}),user=await member(options),a=await artist(admin);
  return {admin,user,artist:a,place:(amount='25000',key=randomUUID())=>placeBuy(db,user,request(a.id,amount,key))};
}
async function counts(user){
  const {rows:[row]}=await pool.query(`SELECT
    (SELECT count(*)::int FROM orders WHERE user_id=$1) orders,
    (SELECT count(*)::int FROM ledger_events WHERE user_id=$1) ledger,
    (SELECT count(*)::int FROM cash_reservations WHERE user_id=$1) reservations,
    (SELECT count(*)::int FROM position_lots WHERE user_id=$1) lots,
    (SELECT count(*)::int FROM receipt_events r JOIN position_lots l ON l.id=r.lot_id WHERE l.user_id=$1) receipts`,[user]);
  return row;
}
async function balanced(user,available,reserved){
  const report=await reconcileWallet(db,user);assert.equal(report.ok,true,JSON.stringify(report));
  assert.deepEqual(report.wallet,{availableCents:String(available),reservedCents:String(reserved)});
  return report;
}

// Historical fixtures model records that were valid when admitted. They do not
// change the real service clock or teach production intake to accept old data.
async function historicalQuote(a,admin,observedAt){
  const id=randomUUID(),observation=randomUUID(),fetched=new Date(observedAt.getTime()+1000),accepted=new Date(observedAt.getTime()+2000);
  const payload={...a.input,sourceEventKey:randomUUID(),observedAt:observedAt.toISOString(),fetchedAt:fetched.toISOString()};
  const evidence={...payload.evidence,observationId:observation,validationVersion:'spotify-listeners-v1'};
  await pool.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
    VALUES ($1,$2,'accepted',10000,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,a.id,payload.sourceUrl,'observation:'+observation,evidence,payload.parserVersion,observedAt,fetched,accepted,admin]);
  await pool.query(`INSERT INTO listener_observations(id,artist_id,source_event_key,payload_hash,payload,status,reasons,validation_version,snapshot_id,actor_id,received_at)
    VALUES ($1,$2,$3,repeat('a',64),$4,'accepted','[]','spotify-listeners-v1',$5,$6,$7)`,[observation,a.id,payload.sourceEventKey,payload,id,admin,accepted]);
  return {id,observedAt,acceptedAt:accepted};
}
async function delayedOrder(f){
  const cutoff=new Date(Math.floor(Date.now()/43200000)*43200000),accepted=new Date(cutoff.getTime()-60000),quote=await historicalQuote(f.artist,f.admin,new Date(accepted.getTime()-60000));
  const id=randomUUID();
  await db.transaction(async tx=>{
    await tx.insert(schema.orders).values({id,userId:f.user,artistId:f.artist.id,side:'buy',amountCents:25000n,requestKey:randomUUID(),requestHash:'a'.repeat(64),placementSnapshotId:quote.id,acceptedAt:accepted,earliestCutoff:cutoff});
    await postOrderMovement(tx,f.user,{kind:'buy_reserve',orderId:id,amountCents:25000n,idempotencyKey:'historical-reserve:'+id});
    await tx.insert(schema.cashReservations).values({orderId:id,userId:f.user,artistId:f.artist.id,amountCents:25000n});
  });
  return id;
}

// This isolated fixture reaches the next eligible logical batch without waiting
// up to twelve hours. It is NOT a public settlement implementation or a bypass
// flag: only these tests write the future quote/batch, under all existing guards.
async function settleFixture(f,orderId,{locked,commit}={}){
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT id FROM artists WHERE id=${f.artist.id} FOR UPDATE`);
    await tx.execute(sql`SELECT user_id FROM members WHERE user_id=${f.user} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM "user" WHERE id=${f.user} FOR UPDATE`);
    await tx.execute(sql`SELECT user_id FROM wallets WHERE user_id=${f.user} FOR UPDATE`);
    const result=await tx.execute(sql`SELECT * FROM orders WHERE id=${orderId} AND user_id=${f.user} FOR UPDATE`),o=result.rows[0];
    if(o.status!=='queued')return false;
    const cutoff=new Date(String(o.earliest_cutoff)),sealed=new Date(cutoff.getTime()+60000),observed=new Date(cutoff.getTime()+120000),accepted=new Date(cutoff.getTime()+121000),executed=new Date(cutoff.getTime()+180000);
    const snapshotId=randomUUID(),batchId=randomUUID(),lotId=randomUUID();
    await tx.insert(schema.listenerSnapshots).values({id:snapshotId,artistId:f.artist.id,status:'accepted',listenerCount:11000n,
      sourceUrl:f.artist.input.sourceUrl,sourceEventKey:randomUUID(),evidence:{fixture:true},parserVersion:'settlement-fixture',
      observedAt:observed,fetchedAt:observed,acceptedAt:accepted,reviewedBy:f.admin});
    await tx.insert(schema.settlementBatches).values({id:batchId,artistId:f.artist.id,cutoff,sealedAt:sealed,eligibleThrough:new Date(cutoff.getTime()-1)});
    await tx.update(schema.settlementBatches).set({status:'executed',snapshotId,executedAt:executed}).where(eq(schema.settlementBatches.id,batchId));
    await postOrderMovement(tx,f.user,{kind:'buy_settle',orderId,amountCents:BigInt(String(o.amount_cents)),idempotencyKey:'fixture-settle:'+orderId});
    await tx.update(schema.cashReservations).set({status:'consumed',resolvedAt:executed}).where(eq(schema.cashReservations.orderId,orderId));
    await tx.update(schema.orders).set({status:'settled',settledAt:executed}).where(eq(schema.orders.id,orderId));
    await tx.insert(schema.settlements).values({orderId,userId:f.user,artistId:f.artist.id,batchId,executedAt:executed,cashCents:BigInt(String(o.amount_cents))});
    await tx.insert(schema.positionLots).values({id:lotId,buyOrderId:orderId,userId:f.user,artistId:f.artist.id,entrySnapshotId:snapshotId,principalCents:BigInt(String(o.amount_cents)),entryListenerCount:11000n,createdAt:executed});
    await tx.insert(schema.receiptEvents).values({id:randomUUID(),lotId,createdAt:executed});
    locked?.();if(commit)await commit;
    return true;
  });
}
async function waitForArtistWaiters(minimum){
  for(let i=0;i<300;i++){
    const {rows:[row]}=await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='first-press-buy-orders-test' AND wait_event_type='Lock' AND query ILIKE '%artists%'");
    if(row.n>=minimum)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('Expected artist-lock waiter did not arrive.');
}

test('placement reserves exact Credits and immutable estimate context without a lot or receipt',async()=>{
  const f=await fixture(),before=Date.now(),result=await f.place('25001'),after=Date.now();
  assert.equal(result.created,true);assert.equal(result.order.status,'queued');assert.equal(result.order.side,'buy');assert.equal(result.order.amountCents,'25001');
  assert.equal(result.order.artistId,f.artist.id);assert.equal(result.order.economyVersion,'backing-v1');assert.equal(result.order.placement.snapshotId,f.artist.observation.snapshotId);
  assert.equal(result.order.placement.listenerCount,'10000');assert.equal(result.order.placement.observedAt,f.artist.input.observedAt);
  const at=Date.parse(result.order.acceptedAt);assert.ok(at>=before&&at<=after);assert.equal(Date.parse(result.order.earliestCutoff),nextUpdateCutoff(at));
  assert.deepEqual(result.wallet,{availableCents:'74999',reservedCents:'25001'});await balanced(f.user,74999,25001);
  assert.deepEqual(await counts(f.user),{orders:1,ledger:2,reservations:1,lots:0,receipts:0});
});
test('minimum backing and spending the exact remaining balance preserve integer cents',async()=>{
  const f=await fixture();assert.deepEqual((await f.place('100')).wallet,{availableCents:'99900',reservedCents:'100'});
  assert.deepEqual((await f.place('99900')).wallet,{availableCents:'0',reservedCents:'100000'});await balanced(f.user,0,100000);
});
test('malformed, fractional, numeric, overflowing and client-authority inputs are rejected before reservation',async()=>{
  const f=await fixture(),base=request(f.artist.id);
  for(const amountCents of ['',0,100,100n,null,'0','99','-100','100.0','1e3','0100',' 100','100 ','9223372036854775808'])await assert.rejects(placeBuy(db,f.user,{...base,amountCents}),orderError('invalid'));
  for(const raw of [null,[],{}, {...base,userId:f.admin},{...base,acceptedAt:new Date().toISOString()},{...base,listenerCount:'1'},{...base,side:'sell'},{...base,status:'settled'},{...base,idempotencyKey:'short'},{...base,idempotencyKey:'x'.repeat(129)}])await assert.rejects(placeBuy(db,f.user,raw),orderError('invalid'));
  await balanced(f.user,100000,0);assert.deepEqual(await counts(f.user),{orders:0,ledger:1,reservations:0,lots:0,receipts:0});
});
test('insufficient and maximum representable requests cannot leave partial orders or cash holds',async()=>{
  const f=await fixture();for(const amount of ['100001',MAX_CENTS.toString()])await assert.rejects(f.place(amount),orderError('insufficient'));
  await balanced(f.user,100000,0);assert.equal((await counts(f.user)).orders,0);
});
test('twenty identical concurrent submits create one order, reservation and reserve ledger event',async()=>{
  const f=await fixture(),key=randomUUID(),results=await Promise.all(Array.from({length:20},()=>f.place('25000',key)));
  assert.equal(results.filter(x=>x.created).length,1);assert.equal(new Set(results.map(x=>x.order.id)).size,1);
  for(const result of results)assert.deepEqual(result.wallet,{availableCents:'75000',reservedCents:'25000'});
  assert.deepEqual(await counts(f.user),{orders:1,ledger:2,reservations:1,lots:0,receipts:0});await balanced(f.user,75000,25000);
});
test('same request key under a different amount or artist conflicts, including concurrent cross-artist submissions',async()=>{
  const f=await fixture(),other=await artist(f.admin),key=randomUUID();await f.place('10000',key);
  await assert.rejects(f.place('10001',key),orderError('conflict'));await assert.rejects(placeBuy(db,f.user,request(other.id,'10000',key)),orderError('conflict'));
  const concurrentKey=randomUUID(),results=await Promise.allSettled([f.artist.id,other.id].map(id=>placeBuy(db,f.user,request(id,'15000',concurrentKey))));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&orderError('conflict')(x.reason)).length,1);
  await balanced(f.user,75000,25000);assert.equal((await counts(f.user)).orders,2);
});
test('simultaneous different-artist buys cannot spend one shared wallet twice',async()=>{
  const f=await fixture(),other=await artist(f.admin);
  const results=await Promise.allSettled([f.artist.id,other.id].map(id=>placeBuy(db,f.user,request(id,'75000'))));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&orderError('insufficient')(x.reason)).length,1);
  await balanced(f.user,25000,75000);assert.deepEqual(await counts(f.user),{orders:1,ledger:2,reservations:1,lots:0,receipts:0});
});
test('requests need an explicitly initialized, active verified member wallet',async()=>{
  for(const options of [{initialized:false},{verified:false},{status:'suspended'}]){
    const f=await fixture(options);await assert.rejects(f.place(),orderError(options.initialized===false?'uninitialized':'ineligible'));
    assert.equal((await counts(f.user)).orders,0);
    if(options.initialized===false)assert.equal((await reconcileWallet(db,f.user)).state,'uninitialized');
  }
  const f=await fixture();await assert.rejects(placeBuy(db,'missing-member',request(f.artist.id)),anyOrderError);
});
test('inactive, synthetic, missing, quarantined, stale and unvalidated artist baselines cannot admit backing',async()=>{
  const f=await fixture();
  for(const status of ['review','suspended','archived']){
    const a=await artist(f.admin);await pool.query('UPDATE artists SET status=$2 WHERE id=$1',[a.id,status]);await assert.rejects(placeBuy(db,f.user,request(a.id)),orderError('ineligible'));
  }
  const synthetic=await artist(f.admin);await pool.query('UPDATE artists SET synthetic=true WHERE id=$1',[synthetic.id]);await assert.rejects(placeBuy(db,f.user,request(synthetic.id)),orderError('ineligible'));
  const missing=await artist(f.admin,{capture:false});await assert.rejects(placeBuy(db,f.user,request(missing.id)),orderError('ineligible'));
  const quarantined=await artist(f.admin,{capture:false});await quarantined.capture({listenerCount:0});await assert.rejects(placeBuy(db,f.user,request(quarantined.id)),orderError('ineligible'));
  const stale=await artist(f.admin,{capture:false});await historicalQuote(stale,f.admin,new Date(Date.now()-48*3600000));await assert.rejects(placeBuy(db,f.user,request(stale.id)),orderError('ineligible'));
  const unvalidated=await artist(f.admin,{capture:false}),at=new Date(Date.now()-60000);
  await pool.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
    VALUES ($1,$2,'accepted',10000,$3,$1,'{}','unvalidated-fixture',$4,$4,$4,$5)`,[randomUUID(),unvalidated.id,unvalidated.input.sourceUrl,at,f.admin]);
  await assert.rejects(placeBuy(db,f.user,request(unvalidated.id)),orderError('ineligible'));await balanced(f.user,100000,0);
});
test('disputed accepted history pauses new backing without releasing existing reservations',async()=>{
  const f=await fixture(),queued=await f.place();
  await pool.query("INSERT INTO snapshot_annotations(id,snapshot_id,kind,reason,actor_id) VALUES ($1,$2,'disputed','Fixture incident review',$3)",[randomUUID(),f.artist.observation.snapshotId,f.admin]);
  await assert.rejects(f.place('100'),orderError('ineligible'));await balanced(f.user,75000,25000);
  assert.equal((await cancelBuy(db,f.user,queued.order.id)).order.status,'cancelled');await balanced(f.user,100000,0);
});
test('admission rechecks member state after waiting for the artist lock',async()=>{
  const f=await fixture(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM artists WHERE id=$1 FOR UPDATE',[f.artist.id]);
  const pending=f.place();
  try{await pool.query("UPDATE members SET status='suspended' WHERE user_id=$1",[f.user]);}
  finally{await lock.query('ROLLBACK');lock.release();}
  await assert.rejects(pending,orderError('ineligible'));assert.equal((await counts(f.user)).orders,0);
});
test('a reservation failure rolls back order, ledger and wallet together',async()=>{
  const f=await fixture();
  await pool.query(`CREATE FUNCTION fp_fail_buy_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${f.user}' THEN RAISE EXCEPTION 'fixture cash hold failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER buy_failure_fixture BEFORE INSERT ON cash_reservations FOR EACH ROW EXECUTE FUNCTION fp_fail_buy_fixture()`);
  try{await assert.rejects(f.place());}finally{await pool.query('DROP TRIGGER buy_failure_fixture ON cash_reservations; DROP FUNCTION fp_fail_buy_fixture()');}
  await balanced(f.user,100000,0);assert.deepEqual(await counts(f.user),{orders:0,ledger:1,reservations:0,lots:0,receipts:0});
});
test('twenty simultaneous cancellations release one reservation exactly once and retries return current state',async()=>{
  const f=await fixture(),key=randomUUID(),placed=await f.place('25001',key);
  const results=await Promise.all(Array.from({length:20},()=>cancelBuy(db,f.user,placed.order.id)));
  assert.equal(results.filter(x=>x.cancelled).length,1);for(const result of results){assert.equal(result.order.status,'cancelled');assert.deepEqual(result.wallet,{availableCents:'100000',reservedCents:'0'});}
  const replay=await f.place('25001',key);assert.equal(replay.created,false);assert.equal(replay.order.id,placed.order.id);assert.equal(replay.order.status,'cancelled');
  const report=await balanced(f.user,100000,0);assert.equal(report.ledger.eventCount,'3');assert.equal((await counts(f.user)).receipts,0);
});
test('another member cannot inspect or cancel an owned order or change its reservation',async()=>{
  const f=await fixture(),other=await member(),placed=await f.place();
  await assert.rejects(cancelBuy(db,other,placed.order.id),orderError('not_found'));await assert.rejects(cancelBuy(db,f.user,randomUUID()),orderError('not_found'));
  const otherDesk=await getBackingDesk(db,other);assert.equal(otherDesk.orders.some(o=>o.id===placed.order.id),false);
  await balanced(f.user,75000,25000);await balanced(other,100000,0);
});
test('artist suspension and failed-update cutoffs never prevent cancellation or idempotent placement replay',async()=>{
  const f=await fixture(),key=randomUUID(),placed=await f.place('10000',key);
  await pool.query("UPDATE artists SET status='suspended' WHERE id=$1",[f.artist.id]);
  const replay=await f.place('10000',key);assert.equal(replay.created,false);assert.equal(replay.order.id,placed.order.id);
  assert.equal((await cancelBuy(db,f.user,placed.order.id)).order.status,'cancelled');
  await pool.query("UPDATE artists SET status='active' WHERE id=$1",[f.artist.id]);
  const delayed=await delayedOrder(f);await pool.query("UPDATE artists SET status='archived' WHERE id=$1",[f.artist.id]);
  assert.equal((await cancelBuy(db,f.user,delayed)).order.status,'cancelled');await balanced(f.user,100000,0);
});
test('new snapshots cannot rewrite an existing order placement estimate or acceptance boundary',async()=>{
  const f=await fixture(),placed=await f.place();
  const newer=await f.artist.capture({sourceEventKey:randomUUID(),listenerCount:'11000',observedAt:new Date(Date.now()-60000).toISOString(),fetchedAt:new Date(Date.now()-59000).toISOString()});assert.equal(newer.status,'accepted');
  const desk=await getBackingDesk(db,f.user),saved=desk.orders.find(o=>o.id===placed.order.id);
  assert.deepEqual(saved.placement,placed.order.placement);assert.equal(saved.acceptedAt,placed.order.acceptedAt);assert.equal(saved.earliestCutoff,placed.order.earliestCutoff);
  assert.equal(desk.artists.find(a=>a.id===f.artist.id).listenerCount,'11000');
});
test('a failed cancellation rolls back refund, cash hold and terminal state atomically',async()=>{
  const f=await fixture(),placed=await f.place();
  await pool.query(`CREATE FUNCTION fp_fail_cancel_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${placed.order.id}' AND NEW.status='cancelled' THEN RAISE EXCEPTION 'fixture cancellation failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER cancel_failure_fixture BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION fp_fail_cancel_fixture()`);
  try{await assert.rejects(cancelBuy(db,f.user,placed.order.id));}finally{await pool.query('DROP TRIGGER cancel_failure_fixture ON orders; DROP FUNCTION fp_fail_cancel_fixture()');}
  await balanced(f.user,75000,25000);const {rows:[row]}=await pool.query('SELECT o.status,c.status reservation FROM orders o JOIN cash_reservations c ON c.order_id=o.id WHERE o.id=$1',[placed.order.id]);assert.deepEqual(row,{status:'queued',reservation:'held'});
});
test('settlement winning the lock race prevents cancellation and never refunds a settled buy',async()=>{
  const f=await fixture(),placed=await f.place();let reached;const locked=new Promise(resolve=>{reached=resolve;});let release;const commit=new Promise(resolve=>{release=resolve;});
  const settlement=settleFixture(f,placed.order.id,{locked:reached,commit});await Promise.race([locked,settlement.then(()=>{throw Error('Fixture settled without reaching its lock barrier.');})]);
  const cancellation=cancelBuy(db,f.user,placed.order.id);let waiterError;
  try{await waitForArtistWaiters(1);}catch(error){waiterError=error;}finally{release();}
  assert.equal(await settlement,true);
  await assert.rejects(cancellation,orderError('settled'));await assert.rejects(cancelBuy(db,f.user,placed.order.id),orderError('settled'));
  if(waiterError)throw waiterError;
  await balanced(f.user,75000,0);assert.deepEqual(await counts(f.user),{orders:1,ledger:3,reservations:1,lots:1,receipts:1});
});
test('cancellation winning a queued lock race prevents the settlement fixture from consuming Credits',async()=>{
  const f=await fixture(),placed=await f.place(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM artists WHERE id=$1 FOR UPDATE',[f.artist.id]);
  let cancellation,settlement;
  try{cancellation=cancelBuy(db,f.user,placed.order.id);await waitForArtistWaiters(1);settlement=settleFixture(f,placed.order.id);await waitForArtistWaiters(2);}
  finally{await lock.query('ROLLBACK');lock.release();}
  assert.equal((await cancellation).order.status,'cancelled');assert.equal(await settlement,false);await balanced(f.user,100000,0);
  assert.deepEqual(await counts(f.user),{orders:1,ledger:3,reservations:1,lots:0,receipts:0});
});
test('cancellation rechecks active verified ownership before releasing reserved Credits',async()=>{
  const f=await fixture(),placed=await f.place();
  await pool.query('UPDATE "user" SET email_verified=false WHERE id=$1',[f.user]);
  await assert.rejects(cancelBuy(db,f.user,placed.order.id),orderError('ineligible'));await balanced(f.user,75000,25000);
  await pool.query('UPDATE "user" SET email_verified=true WHERE id=$1',[f.user]);
  assert.equal((await cancelBuy(db,f.user,placed.order.id)).cancelled,true);await balanced(f.user,100000,0);
});
test('a separately classified demo database cannot authorize a new server backing order',async()=>{
  const name='first_press_order_demo_'+randomUUID().replaceAll('-','')+'_test',target=new URL(url);target.pathname='/'+name;
  await pool.query(`CREATE DATABASE "${name}"`);const other=new pg.Pool({connectionString:target.toString()}),otherDb=drizzle(other,{schema});
  try{
    const migration=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{env:{...process.env,DATABASE_URL:target.toString()},encoding:'utf8',timeout:60000});assert.equal(migration.status,0,migration.stdout+migration.stderr);
    await other.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ('order-demo@example.invalid','fixture',now()+interval '1 day')");
    await other.query("INSERT INTO \"user\"(id,name,email,email_verified) VALUES ('order-demo-admin','Fixture','order-demo@example.invalid',true)");
    await other.query("UPDATE members SET role='admin' WHERE user_id='order-demo-admin'");
    await other.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ('artist','artist','Fixture','1111111111111111111111','active')");
    await initializeWallet(otherDb,'order-demo-admin');
    const capture=await submitListenerObservation(otherDb,'order-demo-admin',{artistId:'artist',sourceEventKey:'fixture-capture',provider:'spotify',metric:'monthly_listeners',providerArtistId:'1111111111111111111111',listenerCount:'10000',sourceUrl:'https://open.spotify.com/artist/1111111111111111111111',evidence:{reference:'fixture/capture.png',sha256:'a'.repeat(64)},parserVersion:'manual-fixture',observedAt:new Date(Date.now()-60000).toISOString(),fetchedAt:new Date(Date.now()-59000).toISOString(),sourceUpdatedAt:null});assert.equal(capture.status,'accepted');
    await other.query("INSERT INTO database_identity(purpose) VALUES ('demo')");
    await assert.rejects(placeBuy(otherDb,'order-demo-admin',request('artist')),orderError('ineligible'));
    assert.equal((await other.query('SELECT count(*)::int n FROM orders')).rows[0].n,0);
    assert.equal((await other.query('SELECT available_cents FROM wallets')).rows[0].available_cents,'100000');
  }finally{await other.end();await pool.query(`DROP DATABASE "${name}"`);}
});
test('backing desk is read-only, paginates owned history and returns no synthetic eligible artists',async()=>{
  const f=await fixture({initialized:false}),before=await counts(f.user),empty=await getBackingDesk(db,f.user);
  assert.equal(empty.wallet,null);assert.deepEqual(await counts(f.user),before);assert.ok(empty.artists.some(a=>a.id===f.artist.id));
  await initializeWallet(db,f.user);
  const ids=[];for(let i=0;i<55;i++)ids.push((await f.place('100')).order.id);
  const seen=[];let cursor,iterations=0;
  do{const page=await getBackingDesk(db,f.user,cursor);assert.ok(page.orders.length<=50);seen.push(...page.orders.map(o=>o.id));cursor=page.nextCursor;assert.ok(++iterations<=3);}while(cursor);
  assert.equal(seen.length,55);assert.equal(new Set(seen).size,55);assert.deepEqual(new Set(seen),new Set(ids));await balanced(f.user,94500,5500);
  await assert.rejects(getBackingDesk(db,f.user,'not-a-real-cursor'),orderError('invalid'));
});
