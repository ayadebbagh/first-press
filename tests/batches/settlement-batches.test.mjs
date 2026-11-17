// A06 / issue #24, first increment only: real PostgreSQL preparation/recovery.
// No executor, payouts, holds or fabricated claim of physically elapsed capture.
import {test as nodeTest,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,symlink,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import * as schema from '../../src/server/db/schema.ts';
import {initializeWallet,postOrderMovement,reconcileWallet} from '../../src/server/backing/ledger.ts';
import {placeBuy} from '../../src/server/backing/buy-orders.ts';
import {cancelOrder} from '../../src/server/backing/exit-orders.ts';
import {seedSettledLots} from '../helpers/settled-lots.mjs';
import {BatchError,sealSettlementBatch,bindBatchSnapshot,expireSettlementBatch,readSettlementBatch} from '../../src/server/backing/settlement-batches.ts';
import {batchDatabaseTarget,assertBatchDatabase,installBatchClock} from '../helpers/batch-clock.mjs';

const {url,expected}=batchDatabaseTarget(process.env.TEST_BATCH_DATABASE_URL);
const pool=new pg.Pool({connectionString:url,max:16,application_name:'first-press-a06-batches-test',connectionTimeoutMillis:5000,statement_timeout:15000});
const db=drizzle(pool,{schema});
const test=(name,action)=>nodeTest(name,{timeout:45000,concurrency:false},action);
const errorCode=error=>error.code??error.cause?.code;
const batchError=code=>error=>error instanceof BatchError&&error.code===code;
const constraint=error=>errorCode(error)==='23514';
let C,clock,legacy,upgradeBefore,upgradeAfter,demoGuardProved=false;
const slot=43_200_000;
// Test controller only. All authoritative service timestamps remain in SQL.
function us(offset=0n){
  const value=BigInt(Date.parse(C))*1000n+BigInt(offset),millis=value/1000n;
  return new Date(Number(millis)).toISOString().slice(0,-1)+String(value%1000n).padStart(3,'0')+'Z';
}
const cutoff=()=>new Date(C);
const seal=(f,connection=db)=>sealSettlementBatch(connection,{artistId:f.artistId,cutoff:cutoff()});
const expiry=7_200_000_000n;

async function migrateThrough(count){
  const root=resolve('.'),directory=await mkdtemp(join(tmpdir(),'firstpress-a06-migrations-'));
  try{
    await mkdir(join(directory,'drizzle/meta'),{recursive:true});await mkdir(join(directory,'scripts/db'),{recursive:true});
    await symlink(join(root,'node_modules'),join(directory,'node_modules'));
    const journal=JSON.parse(await readFile(join(root,'drizzle/meta/_journal.json'),'utf8'));
    if(count!==undefined)journal.entries=journal.entries.slice(0,count);
    await writeFile(join(directory,'drizzle/meta/_journal.json'),JSON.stringify(journal));
    for(const entry of journal.entries)await copyFile(join(root,'drizzle',entry.tag+'.sql'),join(directory,'drizzle',entry.tag+'.sql'));
    for(const file of ['migrate.mjs','connection.mjs'])await copyFile(join(root,'scripts/db',file),join(directory,'scripts/db',file));
    await writeFile(join(directory,'drizzle.config.ts'),"export default {dialect:'postgresql',out:'./drizzle',dbCredentials:{url:process.env.DATABASE_URL}};");
    const result=spawnSync(process.execPath,[join(directory,'scripts/db/migrate.mjs')],{cwd:directory,env:{...process.env,DATABASE_URL:url},encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,result.stdout+result.stderr);
  }finally{await rm(directory,{recursive:true,force:true});}
}

async function member({admin=false}={}){
  const id=randomUUID(),email=id+'@example.invalid';
  await pool.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'a06-historical-test-fixture',clock_timestamp()+interval '1 day')",[email]);
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,\'A06 Test Fixture\',$2,true)',[id,email]);
  if(admin)await pool.query("UPDATE members SET role='admin' WHERE user_id=$1",[id]);
  await initializeWallet(db,id);return id;
}
async function fixture({lots=false}={}){
  const admin=await member({admin:true}),user=await member(),artistId=randomUUID(),spotify=artistId.replaceAll('-','').slice(0,22);
  await pool.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ($1,$1,'A06 Historical Test Fixture',$2,'active')",[artistId,spotify]);
  const f={admin,user,artistId,spotify};
  if(lots)f.lots=await seedSettledLots(db,{userId:user,artistId,adminId:admin,lots:[{principalCents:'10001'},{principalCents:'20003',entryListenerCount:'11000'}]});
  f.baseline=await quote(f,{observedAt:us(-120_000_000n),fetchedAt:us(-119_000_000n),acceptedAt:us(-118_000_000n)});
  return f;
}

// Matched historical C04 rows model immutable stored provenance. These are NOT
// submitListenerObservation calls, actual post-seal collection, or clock proof.
// C04 payload instants remain canonical millisecond ISO, even when SQL clock
// and order acceptance vectors exercise real PostgreSQL microseconds.
async function quote(f,{observedAt=us(1000n),fetchedAt=observedAt,acceptedAt=fetchedAt,capture=true,status='accepted',parent=null,reasons=[]}={}){
  const id=randomUUID(),observationId=randomUUID(),sourceEventKey='a06-historical-fixture:'+observationId;
  const payload={artistId:f.artistId,sourceEventKey,provider:'spotify',metric:'monthly_listeners',providerArtistId:f.spotify,listenerCount:'10000',
    sourceUrl:'https://open.spotify.com/artist/'+f.spotify,evidence:{reference:'test-fixtures/a06/historical/'+observationId+'.json',sha256:'b'.repeat(64)},
    parserVersion:'a06-historical-test-fixture-v1',observedAt:new Date(observedAt).toISOString(),fetchedAt:new Date(fetchedAt).toISOString(),sourceUpdatedAt:null,
    ...(parent?{correctsObservationId:parent,reviewReason:'Historical unsafe-chain upgrade fixture.'}:{})};
  await pool.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,f.artistId,status,status==='accepted'?'10000':null,payload.sourceUrl,'observation:'+observationId,
    {...payload.evidence,observationId,validationVersion:'spotify-listeners-v2'},payload.parserVersion,observedAt,fetchedAt,status==='accepted'?acceptedAt:null,f.admin]);
  if(capture&&status==='accepted')await pool.query(`INSERT INTO listener_observations(id,artist_id,source_event_key,payload_hash,payload,status,reasons,validation_version,snapshot_id,corrects_observation_id,actor_id,received_at)
    VALUES ($1,$2,$3,$4,$5,'accepted',$6,'spotify-listeners-v2',$7,$8,$9,$10)`,[observationId,f.artistId,sourceEventKey,createHash('sha256').update(JSON.stringify(payload)).digest('hex'),payload,JSON.stringify(reasons),id,parent,f.admin,acceptedAt]);
  return {id,observationId,payload,acceptedAt};
}
async function quarantined(f,parent){
  const id=randomUUID(),payload={...parent.payload,sourceEventKey:randomUUID(),correctsObservationId:parent.observationId,reviewReason:'Historical incident fixture.'};
  await pool.query(`INSERT INTO listener_observations(id,artist_id,source_event_key,payload_hash,payload,status,reasons,validation_version,corrects_observation_id,actor_id,received_at)
    VALUES ($1,$2,$3,repeat('c',64),$4,'quarantined','["accepted_correction_requires_incident_review"]','spotify-listeners-v2',$5,$6,$7)`,[id,f.artistId,payload.sourceEventKey,payload,parent.observationId,f.admin,parent.acceptedAt]);
  return id;
}
async function order(f,{id=randomUUID(),acceptedAt=us(-1n),earliest=C,side='buy',amount='100',quanta=1000n}={}){
  await db.transaction(async tx=>{
    await tx.execute(sql`SELECT id FROM artists WHERE id=${f.artistId} FOR UPDATE`);
    await tx.execute(sql`INSERT INTO orders(id,user_id,artist_id,side,amount_cents,exit_basis_points,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff)
      VALUES (${id},${f.user},${f.artistId},${side},${side==='buy'?amount:null}::bigint,${side==='sell'?10000:null}::integer,${randomUUID()},${'a'.repeat(64)},${f.baseline.id},${acceptedAt}::timestamptz,${earliest}::timestamptz)`);
    if(side==='buy'){
      await postOrderMovement(tx,f.user,{kind:'buy_reserve',orderId:id,amountCents:BigInt(amount),idempotencyKey:'a06-reserve:'+id});
      await tx.execute(sql`INSERT INTO cash_reservations(order_id,user_id,artist_id,amount_cents,created_at) VALUES (${id},${f.user},${f.artistId},${amount}::bigint,${acceptedAt}::timestamptz)`);
    }else{
      const lot=f.lots[0].lotId;
      await tx.execute(sql`UPDATE position_lots SET reserved_quanta=reserved_quanta+${quanta.toString()}::bigint WHERE id=${lot}`);
      await tx.execute(sql`INSERT INTO exit_allocations(order_id,lot_id,user_id,artist_id,quanta,created_at) VALUES (${id},${lot},${f.user},${f.artistId},${quanta.toString()}::bigint,${acceptedAt}::timestamptz)`);
    }
  });return id;
}
async function economics(f){
  const {rows:[row]}=await pool.query(`SELECT
    (SELECT to_jsonb(w) FROM wallets w WHERE user_id=$1) wallet,
    (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]') FROM orders o WHERE user_id=$1) orders,
    (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]') FROM ledger_events l WHERE user_id=$1) ledger,
    (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY order_id),'[]') FROM cash_reservations c WHERE user_id=$1) cash,
    (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]') FROM position_lots l WHERE user_id=$1) lots,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY order_id,lot_id),'[]') FROM exit_allocations a WHERE user_id=$1) allocations,
    (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY order_id),'[]') FROM settlements s WHERE user_id=$1) settlements,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM receipt_events r JOIN position_lots l ON l.id=r.lot_id WHERE l.user_id=$1) receipts,
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') FROM rounding_events r JOIN position_lots l ON l.id=r.lot_id WHERE l.user_id=$1) rounding`,[f.user]);
  return row;
}
async function evidence(f){
  return {economics:await economics(f),snapshots:(await pool.query('SELECT to_jsonb(s) row FROM listener_snapshots s WHERE artist_id=$1 ORDER BY id',[f.artistId])).rows,
    captures:(await pool.query('SELECT to_jsonb(c) row FROM listener_observations c WHERE artist_id=$1 ORDER BY id',[f.artistId])).rows,
    batches:(await pool.query('SELECT to_jsonb(b)-\'membership_sealed\' row FROM settlement_batches b WHERE artist_id=$1 ORDER BY id',[f.artistId])).rows};
}
async function unchanged(f,before){assert.deepEqual(await economics(f),before);assert.equal((await reconcileWallet(db,f.user)).ok,true);}
async function batchCount(f){return (await pool.query('SELECT count(*)::int n FROM settlement_batches WHERE artist_id=$1 AND cutoff=$2',[f.artistId,C])).rows[0].n;}
function wire(batch){
  for(const key of ['cutoff','sealedAt','eligibleThrough'])assert.match(batch[key],/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  assert.equal(typeof batch.membershipSealed,'boolean');assert.equal(batch.executedAt,null);
}

// Real independent service connection, also giving us its exact backend PID.
async function worker(instrument){
  const client=new pg.Client({connectionString:url,application_name:'first-press-a06-worker',statement_timeout:15000});client.on('error',()=>{});await client.connect();
  const pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  if(instrument){
    const original=client.query.bind(client);
    client.query=(...args)=>{
      const query=typeof args[0]==='string'?args[0]:args[0].text;
      instrument({phase:'start',query});
      // Observe real driver queries/results only; do not replace any result.
      return original(...args).then(result=>{instrument({phase:'complete',query});return result;});
    };
  }
  return {client,pid,db:drizzle(client,{schema})};
}
async function waitLock(pid,{blocker,kind}={}){
  for(let attempt=0;attempt<500;attempt++){
    const {rows}=await pool.query(`WITH RECURSIVE chain(pid,path) AS (
        SELECT p,ARRAY[$1::integer,p] FROM unnest(pg_blocking_pids($1)) p
        UNION ALL SELECT p,c.path||p FROM chain c CROSS JOIN LATERAL unnest(pg_blocking_pids(c.pid)) p WHERE NOT p=ANY(c.path)
      ) SELECT l.locktype,ARRAY(SELECT pid FROM chain) blockers FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.pid=$1 AND NOT l.granted AND a.wait_event_type='Lock'`,[pid]);
    // Later artist waiters may wait behind an earlier tuple-lock waiter. Follow
    // real PostgreSQL blockers transitively back to the controller's lock.
    if(rows.some(row=>(!kind||row.locktype===kind)&&(!blocker||row.blockers.includes(blocker))))return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('Expected independent PostgreSQL worker lock wait did not arrive.');
}
async function artistBarrier(f,action){
  const lock=await pool.connect();
  await lock.query('BEGIN');const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await lock.query('SELECT id FROM artists WHERE id=$1 FOR UPDATE',[f.artistId]);
  try{return await action(pid);}finally{await lock.query('ROLLBACK');lock.release();}
}
async function fault(f,{table='settlement_batches',event='UPDATE',when='NEW.membership_sealed IS TRUE',body="RAISE EXCEPTION 'a06 injected failure' USING ERRCODE='P0001';"}={},action){
  const name='fp_a06_fault_'+randomUUID().replaceAll('-','');
  assert.ok(['settlement_batches','settlement_batch_orders'].includes(table));
  await pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.artist_id='${f.artistId}' AND (${when}) THEN ${body} END IF; RETURN NEW; END $$`);
  try{
    await pool.query(`CREATE TRIGGER ${name} AFTER ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try{return await action();}finally{await pool.query(`DROP TRIGGER ${name} ON ${table}`);}
  }finally{await pool.query(`DROP FUNCTION public.${name}()`);}
}

before(async()=>{
  // Never provision/override a preexisting or inferred DATABASE_URL target.
  await assertBatchDatabase(pool,expected,{fresh:true});
  C=(await pool.query(`SELECT to_char((date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')-interval '2 days'),
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') c`)).rows[0].c;
  await migrateThrough(8);
  legacy=await fixture({lots:true});await order(legacy);
  const parent=await quarantined(legacy,legacy.baseline);
  await quote(legacy,{parent,observedAt:us(1000n),acceptedAt:us(2000n)});
  await pool.query(`INSERT INTO settlement_batches(id,artist_id,cutoff,sealed_at,eligible_through)
    VALUES ($1,$2,$3,$3,$3::timestamptz-interval '1 microsecond')`,[legacy.legacyId=randomUUID(),legacy.artistId,C]);
  upgradeBefore=await evidence(legacy);
  await migrateThrough();upgradeAfter=await evidence(legacy);
  // Verify demo rejection before installing the singleton test marker. All
  // demo writes roll back; no append-only identity is updated or disabled.
  const demo=await fixture();await order(demo);const money=await economics(demo),abort=Error('rollback demo fixture');
  await assert.rejects(db.transaction(async tx=>{
    await tx.execute(sql`INSERT INTO database_identity(purpose) VALUES ('demo')`);
    await assert.rejects(seal(demo,tx),batchError('ineligible'));demoGuardProved=true;throw abort;
  }),error=>error===abort);
  await unchanged(demo,money);assert.equal(await batchCount(demo),0);
  // This marker is only provisioned because this hook verified the database
  // was entirely empty before applying migrations and creating any fixtures.
  await pool.query("INSERT INTO database_identity(purpose) VALUES ('test')");
});
after(async()=>{try{if(clock)await clock.restore();}finally{await pool.end();}});

// MUST precede controlled-clock installation. Independent of the current hour.
test('unmodified clock is VOLATILE PostgreSQL wall time and sampled after the actual artist-lock query completes',async()=>{
  await assertBatchDatabase(pool,expected);
  const {rows:[row]}=await pool.query(`WITH before AS MATERIALIZED(SELECT clock_timestamp() t),
    sample AS MATERIALIZED(SELECT public.fp_settlement_clock() t FROM before),
    after AS MATERIALIZED(SELECT clock_timestamp() t FROM sample)
    SELECT before.t<=sample.t AND sample.t<=after.t AS ordered FROM before,sample,after`);
  assert.equal(row.ordered,true);
  const {rows:[definition]}=await pool.query(`SELECT p.provolatile,p.prosecdef,pg_get_functiondef(p.oid) ddl FROM pg_proc p WHERE p.oid='public.fp_settlement_clock()'::regprocedure`);
  assert.equal(definition.provolatile,'v');assert.equal(definition.prosecdef,false);
  assert.match(definition.ddl,/pg_catalog\.clock_timestamp\(\)/);assert.doesNotMatch(definition.ddl,/current_setting|fp_a06_test_clock/);
  const f=await fixture(),events=[],w=await worker(event=>events.push(event));let pending;
  try{
    const future=(await pool.query("SELECT (date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '2 days') AT TIME ZONE 'UTC' t")).rows[0].t;
    await artistBarrier(f,async blocker=>{
      pending=sealSettlementBatch(w.db,{artistId:f.artistId,cutoff:future});pending.catch(()=>{});
      await waitLock(w.pid,{blocker});
      assert.equal(events.some(e=>/fp_settlement_clock\s*\(/i.test(e.query)),false,'Clock must not be sampled while waiting for the artist lock.');
    });
    await assert.rejects(pending,batchError('invalid'));
    const lockCompleted=events.findIndex(e=>e.phase==='complete'&&/FROM\s+"?artists"?\b/i.test(e.query)&&/FOR UPDATE/i.test(e.query));
    const sampled=events.findIndex(e=>e.phase==='start'&&/public\.fp_settlement_clock\s*\(/i.test(e.query));
    assert.ok(lockCompleted>=0&&sampled>lockCompleted,'Actual driver completion of artist lock must precede clock query.');
    const expired=await seal(f);assert.equal(expired.status,'skipped');assert.equal(expired.skipReason,'expired');
  }finally{await w.client.end();}
  // Test-only DDL begins only after all default-clock assertions above pass.
  clock=await installBatchClock(pool,expected,us());
});

test('forward migration preserves historical economic/source evidence and immutable legacy NULL membership without fabricating members',async()=>{
  assert.deepEqual(upgradeAfter,upgradeBefore);assert.equal(demoGuardProved,true);
  const rows=(await pool.query('SELECT membership_sealed FROM settlement_batches WHERE artist_id=$1',[legacy.artistId])).rows;
  assert.ok(rows.length>=3);assert.ok(rows.every(row=>row.membership_sealed===null));
  const b=await readSettlementBatch(db,legacy.legacyId);assert.equal(b.membershipSealed,false);assert.deepEqual(b.members,[]);
  await clock.set(us(10_000n));await assert.rejects(bindBatchSnapshot(db,b.id,legacy.baseline.id),batchError('ineligible'));
  await assert.rejects(pool.query('UPDATE settlement_batches SET membership_sealed=true WHERE id=$1',[b.id]),constraint);
  assert.equal((await pool.query('SELECT fp_observation_artist_needs_review($1) blocked',[legacy.artistId])).rows[0].blocked,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM settlement_batch_orders WHERE artist_id=$1',[legacy.artistId])).rows[0].n,0);
});

test('strict acceptance, earliest eligibility, old pending buys/exits and C ordering freeze exact SQL microsecond watermark',async()=>{
  const f=await fixture({lots:true}),prefix=randomUUID();
  const old=await order(f,{acceptedAt:us(-60_000_000n)});
  const z=await order(f,{id:prefix+'z',acceptedAt:us(-1n)}),upper=await order(f,{id:prefix+'Z',acceptedAt:us(-1n)}),lower=await order(f,{id:prefix+'a',acceptedAt:us(-1n)});
  const exit=await order(f,{side:'sell',acceptedAt:us(-500n)});
  const next=new Date(Date.parse(C)+slot).toISOString();
  await order(f,{acceptedAt:us(),earliest:next});await order(f,{acceptedAt:us(1n),earliest:next});
  await order(f,{acceptedAt:us(-2n),earliest:next});
  const cancelled=await order(f,{acceptedAt:us(-3n)});await cancelOrder(db,f.user,cancelled);
  const money=await economics(f);await clock.set(us(1n));const batch=await seal(f);wire(batch);
  assert.equal(batch.status,'sealed');assert.equal(batch.membershipSealed,true);assert.equal(batch.sealedAt,us(1n));assert.equal(batch.eligibleThrough,us(-1n));
  assert.deepEqual(batch.members,[old,exit,upper,lower,z].map((orderId,index)=>({orderId,userId:f.user,artistId:f.artistId,ordinal:index+1})));
  assert.equal((await pool.query(`SELECT to_char(eligible_through AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') exact FROM settlement_batches WHERE id=$1`,[batch.id])).rows[0].exact,us(-1n));
  // A later accepted order cannot alter the sealed set, even if cutoff-eligible.
  await order(f,{acceptedAt:us(-1n)});const laterMoney=await economics(f);
  assert.deepEqual(await seal(f),batch);assert.deepEqual(await readSettlementBatch(db,batch.id),batch);
  await unchanged(f,laterMoney);assert.deepEqual(money.lots,laterMoney.lots);
});

test('empty, paused and review attempts are durable skipped batches without changing money',async()=>{
  for(const status of [null,'review','suspended','archived','disputed']){
    const f=await fixture({lots:true});if(status)await order(f,{side:'sell'});
    if(status==='disputed')await pool.query("INSERT INTO snapshot_annotations(id,snapshot_id,kind,reason,actor_id) VALUES ($1,$2,'disputed','A06 fixture incident',$3)",[randomUUID(),f.baseline.id,f.admin]);
    else if(status)await pool.query('UPDATE artists SET status=$2 WHERE id=$1',[f.artistId,status]);
    const money=await economics(f);await clock.set(us());const b=await seal(f);
    assert.equal(b.status,'skipped');assert.equal(b.skipReason,status==='disputed'?'review_required':status?'artist_unavailable':'no_orders');
    assert.equal(b.membershipSealed,true);assert.equal(b.eligibleThrough,us(-1n));
    assert.deepEqual(await seal(f),b);await unchanged(f,money);
  }
  // Upgrade-preserved unsafe ancestry must independently gate a new slot.
  await clock.set(us(BigInt(slot)*1000n));
  const before=await economics(legacy),b=await sealSettlementBatch(db,{artistId:legacy.artistId,cutoff:new Date(Date.parse(C)+slot)});
  assert.equal(b.status,'skipped');assert.equal(b.skipReason,'review_required');await unchanged(legacy,before);
});

test('invalid caller authority, missing IDs, future cutoffs and synthetic artists cannot create metadata or touch economics',async()=>{
  const f=await fixture();await order(f);const money=await economics(f);await clock.set(us(-1n));
  await assert.rejects(seal(f),batchError('invalid'));
  for(const raw of [null,{},[],{artistId:f.artistId,cutoff:C},{artistId:f.artistId,cutoff:new Date('invalid')},
    {artistId:f.artistId,cutoff:new Date(Date.parse(C)+1)},{artistId:f.artistId,cutoff:cutoff(),now:us()},
    {artistId:f.artistId,cutoff:cutoff(),clock:()=>new Date()}])await assert.rejects(sealSettlementBatch(db,raw),batchError('invalid'));
  await clock.set(us());await assert.rejects(sealSettlementBatch(db,{artistId:randomUUID(),cutoff:cutoff()}),batchError('not_found'));
  for(const id of ['',null,42,'x\0bad']){
    await assert.rejects(readSettlementBatch(db,id),batchError('invalid'));
    await assert.rejects(expireSettlementBatch(db,id),batchError('invalid'));
    await assert.rejects(bindBatchSnapshot(db,id,randomUUID()),batchError('invalid'));
  }
  await assert.rejects(readSettlementBatch(db,randomUUID()),batchError('not_found'));
  await assert.rejects(expireSettlementBatch(db,randomUUID()),batchError('not_found'));
  await pool.query('UPDATE artists SET synthetic=true WHERE id=$1',[f.artistId]);
  await assert.rejects(seal(f),batchError('ineligible'));assert.equal(await batchCount(f),0);await unchanged(f,money);
});

test('membership closure, exact set/watermark, ownership, ordinals and terminal metadata resist direct SQL mutation',async()=>{
  const f=await fixture(),first=await order(f);await clock.set(us());const b=await seal(f);
  const late=await order(f),money=await economics(f);
  for(const query of [
    ['INSERT INTO settlement_batch_orders(batch_id,order_id,user_id,artist_id,ordinal) VALUES ($1,$2,$3,$4,2)',[b.id,late,f.user,f.artistId]],
    ['UPDATE settlement_batch_orders SET ordinal=2 WHERE batch_id=$1',[b.id]],
    ['DELETE FROM settlement_batch_orders WHERE batch_id=$1',[b.id]],
    ['UPDATE settlement_batches SET membership_sealed=false WHERE id=$1',[b.id]],
    ['UPDATE settlement_batches SET membership_sealed=NULL WHERE id=$1',[b.id]],
    ["UPDATE settlement_batches SET eligible_through=eligible_through-interval '1 microsecond' WHERE id=$1",[b.id]],
    ['DELETE FROM settlement_batches WHERE id=$1',[b.id]],
  ])await assert.rejects(pool.query(...query),constraint);
  const insertBuilding=async(tx,id)=>tx.execute(sql`INSERT INTO settlement_batches(id,artist_id,cutoff,sealed_at,eligible_through,membership_sealed)
    VALUES (${id},${f.artistId},${us(BigInt(slot)*1000n)}::timestamptz,${us(BigInt(slot)*1000n)}::timestamptz,${us(-1n)}::timestamptz,false)`);
  // These must fail at real commit, not merely while executing an INSERT.
  await assert.rejects(db.transaction(async tx=>{await insertBuilding(tx,randomUUID());}),constraint);
  await assert.rejects(db.transaction(async tx=>{
    const id=randomUUID();await insertBuilding(tx,id);
    await tx.execute(sql`UPDATE settlement_batches SET membership_sealed=true WHERE id=${id}`);
  }),constraint); // Missing both eligible members despite a plausible watermark.
  for(const duplicate of ['order','ordinal']){
    await assert.rejects(db.transaction(async tx=>{
      const id=randomUUID();await insertBuilding(tx,id);
      await tx.execute(sql`INSERT INTO settlement_batch_orders(batch_id,order_id,user_id,artist_id,ordinal) VALUES (${id},${first},${f.user},${f.artistId},1)`);
      await tx.execute(sql`INSERT INTO settlement_batch_orders(batch_id,order_id,user_id,artist_id,ordinal)
        VALUES (${id},${duplicate==='order'?first:late},${f.user},${f.artistId},${duplicate==='order'?2:1})`);
    }),error=>errorCode(error)==='23505');
  }
  const foreign=await fixture();await order(foreign);
  for(const member of [
    {order:first,user:foreign.user,artist:f.artistId,ordinal:1},
    {order:first,user:f.user,artist:foreign.artistId,ordinal:1},
    {order:first,user:f.user,artist:f.artistId,ordinal:0},
  ]){
    await assert.rejects(db.transaction(async tx=>{
      const id=randomUUID();await insertBuilding(tx,id);
      await tx.execute(sql`INSERT INTO settlement_batch_orders(batch_id,order_id,user_id,artist_id,ordinal)
        VALUES (${id},${member.order},${member.user},${member.artist},${member.ordinal})`);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    }),error=>['23514','23503'].includes(errorCode(error)));
  }
  await clock.set(us(expiry));const terminal=await expireSettlementBatch(db,b.id);
  assert.equal(terminal.status,'skipped');
  for(const assignment of ["status='sealed',skip_reason=NULL","skip_reason='changed'","snapshot_id=NULL"]){
    await assert.rejects(pool.query(`UPDATE settlement_batches SET ${assignment} WHERE id=$1`,[b.id]),constraint);
  }
  await unchanged(f,money);
});

test('C permits sealing; exclusive two-hour endpoint preserves exact SQL microsecond decisions and unbound expiry',async()=>{
  for(const offset of [expiry-1n,expiry,expiry+1n]){
    const f=await fixture();await order(f);const money=await economics(f);
    await clock.set(us());const b=await seal(f);assert.equal(b.sealedAt,us());
    const q=await quote(f);await clock.set(us(offset));
    const early=await expireSettlementBatch(db,b.id);
    if(offset<expiry){
      assert.deepEqual(early,b);const bound=await bindBatchSnapshot(db,b.id,q.id);
      assert.equal(bound.status,'sealed');assert.equal(bound.snapshotId,q.id);
      await clock.set(us(expiry));const expired=await expireSettlementBatch(db,b.id);
      assert.equal(expired.status,'skipped');assert.equal(expired.skipReason,'expired');assert.equal(expired.snapshotId,q.id);
    }else{
      assert.equal(early.status,'skipped');assert.equal(early.skipReason,'expired');assert.equal(early.snapshotId,null);
      assert.deepEqual(await bindBatchSnapshot(db,b.id,q.id),early);
    }
    assert.deepEqual(await expireSettlementBatch(db,b.id),await readSettlementBatch(db,b.id));
    assert.equal((await seal(f)).id,b.id);await unchanged(f,money);
  }
  // Binding itself must commit expired metadata without attaching a quote.
  const f=await fixture();await order(f);await clock.set(us());const b=await seal(f),q=await quote(f);
  await clock.set(us(expiry));const skipped=await bindBatchSnapshot(db,b.id,q.id);
  assert.equal(skipped.status,'skipped');assert.equal(skipped.skipReason,'expired');assert.equal(skipped.snapshotId,null);
});

test('binding SQL chronology distinguishes microsecond sealing from canonical millisecond C04 payloads',async()=>{
  for(const sealAt of [0n,1n]){
    const f=await fixture();await order(f);await clock.set(us(sealAt));const b=await seal(f),money=await economics(f);
    const equalCutoff=await quote(f,{observedAt:us(),fetchedAt:us(),acceptedAt:us()});
    await clock.set(us(10_000n));
    if(sealAt===1n){
      await assert.rejects(bindBatchSnapshot(db,b.id,equalCutoff.id),batchError('ineligible'));
      const fresh=await quote(f);assert.equal((await bindBatchSnapshot(db,b.id,fresh.id)).snapshotId,fresh.id);
    }else{
      assert.equal((await bindBatchSnapshot(db,b.id,equalCutoff.id)).snapshotId,equalCutoff.id,'Observed exactly at a whole-millisecond seal is eligible.');
    }
    await unchanged(f,money);
  }
  const f=await fixture();await order(f);await clock.set(us());const b=await seal(f);
  for(const parameters of [
    {observedAt:us(-1000n)},
    {observedAt:us(1000n),fetchedAt:us(2000n),acceptedAt:us(3000n)},
    {observedAt:us(expiry),fetchedAt:us(expiry),acceptedAt:us(expiry)},
    {capture:false},
    {status:'quarantined'},
  ]){
    await clock.set(us(2999n));const q=await quote(f,parameters);
    await assert.rejects(bindBatchSnapshot(db,b.id,q.id),batchError('ineligible'));
    assert.equal((await readSettlementBatch(db,b.id)).snapshotId,null);
  }
  // Equality at acceptance is permitted; +1 microsecond logical time is not
  // required when accepted_at already equals the sampled database clock.
  const q=await quote(f,{observedAt:us(1000n),fetchedAt:us(2000n),acceptedAt:us(3000n)});
  await clock.set(us(3000n));assert.equal((await bindBatchSnapshot(db,b.id,q.id)).snapshotId,q.id);
});

test('C04 ownership/canonical identity, missing capture, unsafe ancestry and dispute gates cannot authorize a quote',async()=>{
  const f=await fixture();await order(f);await clock.set(us());const b=await seal(f),other=await fixture(),wrong=await quote(other);
  await clock.set(us(10_000n));const money=await economics(f);
  await assert.rejects(bindBatchSnapshot(db,b.id,randomUUID()),batchError('not_found'));
  await assert.rejects(bindBatchSnapshot(db,b.id,wrong.id),batchError('ineligible'));
  const q=await quote(f);
  await pool.query('UPDATE artists SET spotify_artist_id=$2 WHERE id=$1',[f.artistId,'Z'.repeat(22)]);
  await assert.rejects(bindBatchSnapshot(db,b.id,q.id),batchError('ineligible'));
  await pool.query('UPDATE artists SET spotify_artist_id=$2 WHERE id=$1',[f.artistId,f.spotify]);
  assert.equal((await bindBatchSnapshot(db,b.id,q.id)).snapshotId,q.id);await unchanged(f,money);
  for(const gate of ['suspended','disputed','synthetic']){
    const clean=await fixture();await order(clean);await clock.set(us());const batch=await seal(clean),fresh=await quote(clean),before=await economics(clean);
    if(gate==='disputed')await pool.query("INSERT INTO snapshot_annotations(id,snapshot_id,kind,reason,actor_id) VALUES ($1,$2,'disputed','A06 pre-bind dispute',$3)",[randomUUID(),fresh.id,clean.admin]);
    else if(gate==='synthetic')await pool.query('UPDATE artists SET synthetic=true WHERE id=$1',[clean.artistId]);
    else await pool.query("UPDATE artists SET status='suspended' WHERE id=$1",[clean.artistId]);
    await clock.set(us(10_000n));
    if(gate==='synthetic')await assert.rejects(bindBatchSnapshot(db,batch.id,fresh.id),batchError('ineligible'));
    else{
      const skipped=await bindBatchSnapshot(db,batch.id,fresh.id);assert.equal(skipped.status,'skipped');
      assert.equal(skipped.skipReason,gate==='disputed'?'review_required':'artist_unavailable');assert.equal(skipped.snapshotId,null);
    }
    await unchanged(clean,before);
  }
});

test('same-ID replay precedes current deadline/artist gates, survives terminal expiry, and rejects replacement or clearing',async()=>{
  const f=await fixture();await order(f);await clock.set(us());const b=await seal(f),q=await quote(f),other=await quote(f);
  await clock.set(us(10_000n));const bound=await bindBatchSnapshot(db,b.id,q.id),money=await economics(f);
  for(const value of [us(-1n),us(expiry+1n)]){
    await clock.set(value);await pool.query("UPDATE artists SET status='suspended',synthetic=true WHERE id=$1",[f.artistId]);
    assert.deepEqual(await bindBatchSnapshot(db,b.id,q.id),bound);
    await assert.rejects(bindBatchSnapshot(db,b.id,other.id),batchError('conflict'));
  }
  await assert.rejects(pool.query('UPDATE settlement_batches SET snapshot_id=NULL WHERE id=$1',[b.id]),constraint);
  await assert.rejects(pool.query('UPDATE settlement_batches SET snapshot_id=$2 WHERE id=$1',[b.id,other.id]),constraint);
  const expired=await expireSettlementBatch(db,b.id);assert.equal(expired.snapshotId,q.id);assert.equal(expired.status,'skipped');
  assert.deepEqual(await bindBatchSnapshot(db,b.id,q.id),expired);
  await assert.rejects(bindBatchSnapshot(db,b.id,other.id),batchError('conflict'));
  assert.deepEqual(await seal(f),expired);await unchanged(f,money);
});

test('competing independent seals serialize to one durable ID, watermark and member set',async()=>{
  const f=await fixture();await order(f);await clock.set(us());const money=await economics(f),a=await worker(),b=await worker();let left,right;
  try{
    await artistBarrier(f,async blocker=>{
      left=seal(f,a.db);left.catch(()=>{});await waitLock(a.pid,{blocker});
      right=seal(f,b.db);right.catch(()=>{});await waitLock(b.pid,{blocker});
    });
    assert.deepEqual(await left,await right);assert.equal(await batchCount(f),1);await unchanged(f,money);
  }finally{await a.client.end();await b.client.end();}
});

test('competing same-ID bindings replay; different IDs yield one winner and one conflict',async()=>{
  for(const same of [true,false]){
    const f=await fixture();await order(f);await clock.set(us());const batch=await seal(f),q=await quote(f),second=same?q:await quote(f);
    await clock.set(us(10_000n));const money=await economics(f),a=await worker(),b=await worker();let left,right;
    try{
      await artistBarrier(f,async blocker=>{
        left=bindBatchSnapshot(a.db,batch.id,q.id);left.catch(()=>{});await waitLock(a.pid,{blocker});
        right=bindBatchSnapshot(b.db,batch.id,second.id);right.catch(()=>{});await waitLock(b.pid,{blocker});
      });
      const results=await Promise.allSettled([left,right]),fulfilled=results.filter(r=>r.status==='fulfilled');
      assert.equal(fulfilled.length,same?2:1);
      if(same)assert.deepEqual(fulfilled[0].value,fulfilled[1].value);
      else assert.equal(results.filter(r=>r.status==='rejected'&&batchError('conflict')(r.reason)).length,1);
      const stored=await readSettlementBatch(db,batch.id);assert.equal(stored.snapshotId,fulfilled[0].value.snapshotId);await unchanged(f,money);
    }finally{await a.client.end();await b.client.end();}
  }
});

test('all mutators resample committed DB time after independent artist-lock waits',async()=>{
  // Sealing begins before cutoff but acquires its artist lock one microsecond
  // after it. This specifically catches a clock sample before the lock.
  const f=await fixture();await order(f);const w=await worker();let pending;
  try{
    await clock.set(us(-1n));await artistBarrier(f,async blocker=>{
      pending=seal(f,w.db);pending.catch(()=>{});await waitLock(w.pid,{blocker});await clock.set(us(1n));
    });
    assert.equal((await pending).sealedAt,us(1n));
  }finally{await w.client.end();}
  for(const method of ['bind','expire']){
    const f=await fixture();await order(f);await clock.set(us());const b=await seal(f),q=await quote(f),money=await economics(f),w=await worker();let pending;
    try{
      await clock.set(us(expiry-1n));await artistBarrier(f,async blocker=>{
        pending=method==='bind'?bindBatchSnapshot(w.db,b.id,q.id):expireSettlementBatch(w.db,b.id);pending.catch(()=>{});
        await waitLock(w.pid,{blocker});await clock.set(us(expiry));
      });
      const result=await pending;assert.equal(result.status,'skipped');assert.equal(result.skipReason,'expired');assert.equal(result.snapshotId,null);await unchanged(f,money);
    }finally{await w.client.end();}
  }
});

test('cancellation before/after a competing seal remains available while membership is immutable for both buys and exits',async()=>{
  for(const side of ['buy','sell'])for(const cancelFirst of [true,false]){
    const f=await fixture({lots:side==='sell'}),id=await order(f,{side}),a=await worker(),b=await worker();let sealing,cancelling;
    await clock.set(us());
    try{
      await artistBarrier(f,async blocker=>{
        if(cancelFirst){
          cancelling=cancelOrder(a.db,f.user,id);cancelling.catch(()=>{});await waitLock(a.pid,{blocker});
          sealing=seal(f,b.db);sealing.catch(()=>{});await waitLock(b.pid,{blocker});
        }else{
          sealing=seal(f,a.db);sealing.catch(()=>{});await waitLock(a.pid,{blocker});
          cancelling=cancelOrder(b.db,f.user,id);cancelling.catch(()=>{});await waitLock(b.pid,{blocker});
        }
      });
      assert.equal((await cancelling).cancelled,true);const result=await sealing;
      assert.deepEqual(result.members.map(m=>m.orderId),cancelFirst?[]:[id]);
      assert.deepEqual((await readSettlementBatch(db,result.id)).members,result.members);
      const money=await economics(f);await clock.set(us(expiry));await expireSettlementBatch(db,result.id);await unchanged(f,money);
      assert.equal(money.orders.find(o=>o.id===id).status,'cancelled');
      assert.ok(money.cash.every(r=>r.status!=='held'));assert.ok(money.allocations.every(r=>r.status!=='held'));
      assert.equal(money.receipts.length,side==='sell'?2:0,'Preparation/cancellation creates no new receipt.');
    }finally{await a.client.end();await b.client.end();}
  }
});

test('expiry versus binding at the exclusive deadline cannot attach a quote or release any reservation',async()=>{
  for(const bindFirst of [true,false]){
    const f=await fixture({lots:true});await order(f);await order(f,{side:'sell'});await clock.set(us());
    const batch=await seal(f),q=await quote(f),money=await economics(f),a=await worker(),b=await worker();let one,two;
    try{
      await clock.set(us(expiry-1n));await artistBarrier(f,async blocker=>{
        one=bindFirst?bindBatchSnapshot(a.db,batch.id,q.id):expireSettlementBatch(a.db,batch.id);one.catch(()=>{});await waitLock(a.pid,{blocker});
        two=bindFirst?expireSettlementBatch(b.db,batch.id):bindBatchSnapshot(b.db,batch.id,q.id);two.catch(()=>{});await waitLock(b.pid,{blocker});
        await clock.set(us(expiry));
      });
      assert.deepEqual(await one,await two);const stored=await readSettlementBatch(db,batch.id);
      assert.equal(stored.status,'skipped');assert.equal(stored.snapshotId,null);assert.equal(stored.skipReason,'expired');await unchanged(f,money);
    }finally{await a.client.end();await b.client.end();}
  }
});

test('post-write deadline crossing rolls back the quote savepoint and commits only skipped metadata',async()=>{
  const f=await fixture({lots:true});await order(f);await order(f,{side:'sell'});await clock.set(us());const b=await seal(f),q=await quote(f),money=await economics(f);
  const lock=await pool.connect(),w=await worker(),key=1_900_000_001;let pending;
  try{
    await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock($1)',[key]);
    const blocker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await fault(f,{when:'OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL',body:`PERFORM pg_advisory_xact_lock(${key});`},async()=>{
      try{
        await clock.set(us(expiry-1n));pending=bindBatchSnapshot(w.db,b.id,q.id);pending.catch(()=>{});
        await waitLock(w.pid,{blocker,kind:'advisory'});
        assert.equal((await readSettlementBatch(db,b.id)).snapshotId,null,'Uncommitted attachment must not be visible.');
        await clock.set(us(expiry));
      }finally{await lock.query('ROLLBACK');}
      const result=await pending;assert.equal(result.status,'skipped');assert.equal(result.skipReason,'expired');assert.equal(result.snapshotId,null);
      assert.equal((await readSettlementBatch(db,b.id)).snapshotId,null);
    });
    await unchanged(f,money);
  }finally{await lock.query('ROLLBACK');lock.release();await w.client.end();}
});

test('membership/finalization/bind write failures roll back fully, and a lost committed response replays stored results',async()=>{
  for(const injection of [
    {table:'settlement_batch_orders',event:'INSERT',when:'true'},
    {when:'NEW.membership_sealed IS TRUE'},
  ]){
    const f=await fixture({lots:true});await order(f);await order(f,{side:'sell'});await clock.set(us());const money=await economics(f);
    await fault(f,injection,async()=>{await assert.rejects(seal(f),error=>errorCode(error)==='P0001');});
    assert.equal(await batchCount(f),0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM settlement_batch_orders WHERE artist_id=$1',[f.artistId])).rows[0].n,0);
    await unchanged(f,money);const retry=await seal(f);assert.equal(retry.members.length,2);assert.equal(retry.membershipSealed,true);
  }
  const f=await fixture();await order(f);await clock.set(us());const b=await seal(f),q=await quote(f),money=await economics(f);await clock.set(us(10_000n));
  await fault(f,{when:'OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL'},async()=>{
    await assert.rejects(bindBatchSnapshot(db,b.id,q.id),error=>errorCode(error)==='P0001');
  });
  assert.deepEqual(await readSettlementBatch(db,b.id),b);await unchanged(f,money);
  const result=await bindBatchSnapshot(db,b.id,q.id); // Response deliberately discarded by caller below.
  const restarted=await worker();
  try{assert.deepEqual(await bindBatchSnapshot(restarted.db,b.id,q.id),result);assert.deepEqual(await seal(f,restarted.db),result);}
  finally{await restarted.client.end();}
  await unchanged(f,money);
});

test('worker disconnect before commit leaves neither partial membership nor quote and allows safe restart',async()=>{
  for(const phase of ['seal','bind']){
    const f=await fixture();await order(f);await clock.set(us());const b=phase==='bind'?await seal(f):null,q=phase==='bind'?await quote(f):null,money=await economics(f);
    const w=await worker(),lock=await pool.connect(),key=1_900_000_002;let pending;
    try{
      await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock($1)',[key]);
      const blocker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await fault(f,{when:phase==='bind'?'OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL':'NEW.membership_sealed IS TRUE',body:`PERFORM pg_advisory_xact_lock(${key});`},async()=>{
        try{
          await clock.set(us(10_000n));pending=phase==='bind'?bindBatchSnapshot(w.db,b.id,q.id):seal(f,w.db);pending.catch(()=>{});
          await waitLock(w.pid,{blocker,kind:'advisory'});
          assert.equal((await pool.query('SELECT pg_terminate_backend($1) terminated',[w.pid])).rows[0].terminated,true);
          await assert.rejects(pending);
        }finally{await lock.query('ROLLBACK');}
      });
      if(phase==='seal')assert.equal(await batchCount(f),0);else assert.deepEqual(await readSettlementBatch(db,b.id),b);
      const retry=phase==='seal'?await seal(f):await bindBatchSnapshot(db,b.id,q.id);
      assert.equal(retry.membershipSealed,true);assert.equal(retry.status,'sealed');await unchanged(f,money);
    }finally{await lock.query('ROLLBACK');lock.release();await w.client.end();}
  }
});

test('expired membership does not strand queued orders; later batch cannot reuse its older quote',async()=>{
  const f=await fixture();const id=await order(f);await clock.set(us());const first=await seal(f),q=await quote(f),money=await economics(f);
  await clock.set(us(expiry));await expireSettlementBatch(db,first.id);
  const next=new Date(Date.parse(C)+slot);await clock.set(us(BigInt(slot)*1000n));
  const later=await sealSettlementBatch(db,{artistId:f.artistId,cutoff:next});assert.deepEqual(later.members.map(m=>m.orderId),[id]);
  await assert.rejects(bindBatchSnapshot(db,later.id,q.id),batchError('ineligible'));
  assert.equal((await readSettlementBatch(db,later.id)).snapshotId,null);await unchanged(f,money);
});


test('direct FALSE insert serializes even an empty membership against actual buy admission',async()=>{
  const f=await fixture();
  const observed=(await pool.query(`SELECT to_char(date_trunc('milliseconds',clock_timestamp()-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t`)).rows[0].t;
  await quote(f,{observedAt:observed});
  const writer=await worker(),buyer=await worker(),id=randomUUID();let pending;
  try{
    await writer.client.query('BEGIN');
    // No explicit artist lock here: the INSERT trigger must acquire it itself.
    await writer.client.query(`INSERT INTO settlement_batches(id,artist_id,cutoff,sealed_at,eligible_through,membership_sealed)
      VALUES ($1,$2,$3,$3,$3::timestamptz-interval '1 microsecond',false)`,[id,f.artistId,C]);
    try{
      pending=placeBuy(buyer.db,f.user,{artistId:f.artistId,amountCents:'100',idempotencyKey:randomUUID()});pending.catch(()=>{});
      await waitLock(buyer.pid,{blocker:writer.pid});
      await writer.client.query('UPDATE settlement_batches SET membership_sealed=true WHERE id=$1',[id]);
      await writer.client.query('COMMIT');
    }catch(error){await writer.client.query('ROLLBACK');throw error;}
    const placed=await pending,batch=await readSettlementBatch(db,id);
    assert.equal(batch.membershipSealed,true);assert.deepEqual(batch.members,[]);
    assert.equal(placed.order.status,'queued');assert.deepEqual(placed.wallet,{availableCents:'99900',reservedCents:'100'});
    assert.equal((await pool.query('SELECT accepted_at>=$2::timestamptz AS late FROM orders WHERE id=$1',[placed.order.id,C])).rows[0].late,true);
    assert.deepEqual((await readSettlementBatch(db,id)).members,[]);
  }finally{await writer.client.query('ROLLBACK');await writer.client.end();await buyer.client.end();}
});

test('direct FALSE insert waits for real admission; stale precomputed empty membership cannot finalize after admission commits',async()=>{
  const f=await fixture(),observed=(await pool.query(`SELECT to_char(date_trunc('milliseconds',clock_timestamp()-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t`)).rows[0].t;
  await quote(f,{observedAt:observed});
  const buyer=await worker(),writer=await worker(),id=randomUUID();let release,reached;
  const committed=new Promise(resolve=>{release=resolve;}),admitted=new Promise(resolve=>{reached=resolve;});
  const admission=buyer.db.transaction(async tx=>{
    const result=await placeBuy(tx,f.user,{artistId:f.artistId,amountCents:'100',idempotencyKey:randomUUID()});
    reached(result);await committed;return result;
  });admission.catch(()=>{});
  try{
    const placed=await Promise.race([admitted,admission.then(()=>{throw Error('Admission missed its transaction barrier.');})]);
    await writer.client.query('BEGIN');let insertion;
    try{
      insertion=writer.client.query(`INSERT INTO settlement_batches(id,artist_id,cutoff,sealed_at,eligible_through,membership_sealed)
        VALUES ($1,$2,$3,$3,$3::timestamptz-interval '1 microsecond',false)`,[id,f.artistId,placed.order.earliestCutoff]);insertion.catch(()=>{});
      try{await waitLock(writer.pid,{blocker:buyer.pid});}finally{release();}
      await admission;await insertion;
      await assert.rejects(writer.client.query('UPDATE settlement_batches SET membership_sealed=true WHERE id=$1',[id]),constraint);
    }finally{await writer.client.query('ROLLBACK');}
    assert.equal((await pool.query('SELECT count(*)::int n FROM settlement_batches WHERE id=$1',[id])).rows[0].n,0);
    assert.equal((await reconcileWallet(db,f.user)).ok,true);
  }finally{release();await admission.catch(()=>{});await writer.client.end();await buyer.client.end();}
});

test('sealing that crosses the final deadline commits immutable membership as skipped without touching money',async()=>{
  const f=await fixture();await order(f);const money=await economics(f),w=await worker(),lock=await pool.connect(),key=1_900_000_003;let pending;
  try{
    await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock($1)',[key]);
    const blocker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await fault(f,{when:'NEW.membership_sealed IS TRUE',body:`PERFORM pg_advisory_xact_lock(${key});`},async()=>{
      try{
        await clock.set(us(expiry-1n));pending=seal(f,w.db);pending.catch(()=>{});await waitLock(w.pid,{blocker,kind:'advisory'});
        await clock.set(us(expiry));
      }finally{await lock.query('ROLLBACK');}
      const batch=await pending;assert.equal(batch.sealedAt,us(expiry-1n));assert.equal(batch.status,'skipped');assert.equal(batch.skipReason,'expired');
      assert.equal(batch.membershipSealed,true);assert.equal(batch.members.length,1);assert.deepEqual(await seal(f),batch);
    });
    await unchanged(f,money);
  }finally{await lock.query('ROLLBACK');lock.release();await w.client.end();}
});

test('a dispute committed after quote write rolls back the binding rather than returning unsafe evidence',async()=>{
  const f=await fixture();await order(f);await clock.set(us());const batch=await seal(f),q=await quote(f),money=await economics(f);
  const w=await worker(),lock=await pool.connect(),key=1_900_000_004;let pending;
  try{
    await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock($1)',[key]);
    const blocker=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await fault(f,{when:'OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL',body:`PERFORM pg_advisory_xact_lock(${key});`},async()=>{
      try{
        await clock.set(us(10_000n));pending=bindBatchSnapshot(w.db,batch.id,q.id);pending.catch(()=>{});await waitLock(w.pid,{blocker,kind:'advisory'});
        await pool.query("INSERT INTO snapshot_annotations(id,snapshot_id,kind,reason,actor_id) VALUES ($1,$2,'disputed','Concurrent post-write review fixture',$3)",[randomUUID(),q.id,f.admin]);
      }finally{await lock.query('ROLLBACK');}
      await assert.rejects(pending,batchError('ineligible'));assert.deepEqual(await readSettlementBatch(db,batch.id),batch);
    });
    await unchanged(f,money);
  }finally{await lock.query('ROLLBACK');lock.release();await w.client.end();}
});

test('newer historical execution supersedes earlier preparation and binding without repricing old orders',async()=>{
  for(const bind of [false,true]){
    const f=await fixture();await order(f);await clock.set(us());const early=bind?await seal(f):null;
    const later=BigInt(slot)*1000n,q=await quote(f,{observedAt:us(later+1000n),acceptedAt:us(later+2000n)}),legacyId=randomUUID();
    // Explicit legacy setup only: exercising preexisting executed evidence,
    // never claiming the new service executed a trade or produced a receipt.
    await pool.query(`INSERT INTO settlement_batches(id,artist_id,cutoff,sealed_at,eligible_through)
      VALUES ($1,$2,$3,$3,$4)`,[legacyId,f.artistId,us(later),us(-1n)]);
    await pool.query("UPDATE settlement_batches SET status='executed',snapshot_id=$2,executed_at=$3 WHERE id=$1",[legacyId,q.id,us(later+3000n)]);
    const money=await economics(f);await clock.set(us(10_000n));
    const result=bind?await bindBatchSnapshot(db,early.id,(await quote(f)).id):await seal(f);
    assert.equal(result.status,'skipped');assert.equal(result.skipReason,'superseded');assert.equal(result.snapshotId,null);await unchanged(f,money);
  }
});
