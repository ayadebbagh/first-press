import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import * as schema from '../../src/server/db/schema.ts';
import {initializeWallet,postOrderMovement,reconcileWallet,LedgerError} from '../../src/server/backing/ledger.ts';
import {MAX_CENTS} from '../../src/domain/backing-policy.ts';
const url=process.env.TEST_LEDGER_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('_ledger_test'))throw Error('Use an explicit disposable TEST_LEDGER_DATABASE_URL ending _ledger_test.');
const pool=new pg.Pool({connectionString:url,max:24}),db=drizzle(pool,{schema});
before(()=>{const r=spawnSync(process.execPath,['scripts/db/migrate.mjs'],{env:{...process.env,DATABASE_URL:url},encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stdout+r.stderr);});
after(async()=>{await pool.end();});
async function member(verified=true){
  const id=randomUUID(),email=id+'@example.invalid';
  await pool.query("INSERT INTO beta_invites(email,created_by,expires_at) VALUES ($1,'ledger-fixture',now()+interval '1 day')",[email]);
  await pool.query('INSERT INTO "user"(id,name,email,email_verified) VALUES ($1,\'Ledger Fixture\',$2,$3)',[id,email,verified]);
  return id;
}
async function order(userId,amount='25000'){
  const id=randomUUID(),artist=randomUUID(),snapshot=randomUUID(),accepted=new Date(),cutoff=new Date((Math.floor(accepted.getTime()/43200000)+1)*43200000);
  await pool.query("INSERT INTO artists(id,slug,name,spotify_artist_id,status) VALUES ($1,$1,'Ledger Fixture',substring(replace($1,'-','') from 1 for 22),'active')",[artist]);
  await pool.query(`INSERT INTO listener_snapshots(id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by)
    VALUES ($1,$2,'accepted',10000,'https://example.invalid',$1,'{}','fixture',$3,$3,$3,'fixture')`,[snapshot,artist,new Date(accepted.getTime()-60000)]);
  await pool.query(`INSERT INTO orders(id,user_id,artist_id,side,amount_cents,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff)
    VALUES ($1,$2,$3,'buy',$4,$1,repeat('a',64),$5,$6,$7)`,[id,userId,artist,amount,snapshot,accepted,cutoff]);
  return {id,artist,amount:BigInt(amount)};
}
async function reserve(userId,o,key='reserve:'+o.id){
  return db.transaction(async tx=>{
    const posted=await postOrderMovement(tx,userId,{kind:'buy_reserve',orderId:o.id,amountCents:o.amount,idempotencyKey:key});
    if(posted.applied)await tx.insert(schema.cashReservations).values({orderId:o.id,userId,artistId:o.artist,amountCents:o.amount});
    return posted;
  });
}
const ledgerError=code=>e=>e instanceof LedgerError&&e.code===code;

test('twenty concurrent initialization retries create exactly one fixed starting grant',async()=>{
  const id=await member();const results=await Promise.all(Array.from({length:20},()=>initializeWallet(db,id)));
  assert.equal(results.filter(x=>x.created).length,1);assert.equal(new Set(results.map(x=>x.eventId)).size,1);
  for(const result of results)assert.deepEqual(result.wallet,{availableCents:100000n,reservedCents:0n});
  const report=await reconcileWallet(db,id);assert.equal(report.ok,true);assert.equal(report.ledger.startingGrantCount,'1');assert.equal(report.ledger.eventCount,'1');
});

test('only active verified members are eligible, and accounts receive independent grants',async()=>{
  const unverified=await member(false);await assert.rejects(initializeWallet(db,unverified),ledgerError('ineligible'));
  const suspended=await member();await pool.query("UPDATE members SET status='suspended' WHERE user_id=$1",[suspended]);await assert.rejects(initializeWallet(db,suspended),ledgerError('ineligible'));
  await assert.rejects(initializeWallet(db,'unknown-account'),ledgerError('ineligible'));
  const a=await member(),b=await member();const results=await Promise.all([initializeWallet(db,a),initializeWallet(db,b)]);assert.ok(results.every(x=>x.created));
  assert.notEqual(results[0].eventId,results[1].eventId);
  assert.equal((await reconcileWallet(db,unverified)).state,'uninitialized');
});

test('reserve, replay, cancel and initialize replay preserve exact balances and unique events',async()=>{
  const id=await member();const grant=await initializeWallet(db,id),o=await order(id);
  const first=await reserve(id,o),again=await reserve(id,o);
  assert.equal(first.applied,true);assert.equal(again.applied,false);assert.equal(first.eventId,again.eventId);
  assert.deepEqual(first.wallet,{availableCents:75000n,reservedCents:25000n});
  const grantReplay=await initializeWallet(db,id);assert.equal(grantReplay.eventId,grant.eventId);assert.equal(grantReplay.created,false);assert.deepEqual(grantReplay.wallet,first.wallet);
  await db.transaction(async tx=>{
    await postOrderMovement(tx,id,{kind:'buy_cancel',orderId:o.id,amountCents:o.amount,idempotencyKey:'cancel:'+o.id});
    await tx.execute(sql`UPDATE cash_reservations SET status='released',resolved_at=now() WHERE order_id=${o.id}`);
    await tx.execute(sql`UPDATE orders SET status='cancelled',cancelled_at=now() WHERE id=${o.id}`);
  });
  const report=await reconcileWallet(db,id);assert.equal(report.ok,true);assert.deepEqual(report.wallet,{availableCents:'100000',reservedCents:'0'});assert.equal(report.ledger.eventCount,'3');
});

test('concurrent reservations cannot spend the same available Credits twice',async()=>{
  const id=await member();await initializeWallet(db,id);const a=await order(id,'75000'),b=await order(id,'75000');
  const outcomes=await Promise.allSettled([reserve(id,a),reserve(id,b)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='insufficient').length,1);
  const report=await reconcileWallet(db,id);assert.equal(report.ok,true);assert.deepEqual(report.wallet,{availableCents:'25000',reservedCents:'75000'});assert.equal(report.ledger.eventCount,'2');
});

test('exceptions and incomplete cash-hold transactions roll back money and ledger together',async()=>{
  const id=await member();await initializeWallet(db,id);const o=await order(id);
  await assert.rejects(db.transaction(async tx=>{await postOrderMovement(tx,id,{kind:'buy_reserve',orderId:o.id,amountCents:o.amount,idempotencyKey:'rollback'});throw Error('fixture failure');}),/fixture failure/);
  await assert.rejects(db.transaction(tx=>postOrderMovement(tx,id,{kind:'buy_reserve',orderId:o.id,amountCents:o.amount,idempotencyKey:'incomplete'})),e=>(e.code??e.cause?.code)==='23514');
  const report=await reconcileWallet(db,id);assert.equal(report.ok,true);assert.equal(report.ledger.eventCount,'1');assert.equal(report.wallet.availableCents,'100000');
});

test('negative, floating, overflowing, unknown-kind and cross-owner movements cannot debit or mint',async()=>{
  const id=await member(),other=await member();await initializeWallet(db,id);await initializeWallet(db,other);const o=await order(id);
  for(const amount of [-1n,1.5,'25000',MAX_CENTS+1n])await assert.rejects(db.transaction(tx=>postOrderMovement(tx,id,{kind:'buy_reserve',orderId:o.id,amountCents:amount,idempotencyKey:'invalid'})),e=>e instanceof LedgerError);
  await assert.rejects(db.transaction(tx=>postOrderMovement(tx,id,{kind:'weekly_grant',orderId:o.id,amountCents:1n,idempotencyKey:'weekly'})),ledgerError('invalid'));
  await assert.rejects(db.transaction(tx=>postOrderMovement(tx,other,{kind:'buy_reserve',orderId:o.id,amountCents:o.amount,idempotencyKey:'stolen'})),ledgerError('ineligible'));
  const sell=randomUUID();
  await pool.query(`INSERT INTO orders(id,user_id,artist_id,side,exit_basis_points,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff)
    SELECT $1,user_id,artist_id,'sell',10000,$1,repeat('b',64),placement_snapshot_id,accepted_at,earliest_cutoff FROM orders WHERE id=$2`,[sell,o.id]);
  await assert.rejects(db.transaction(tx=>postOrderMovement(tx,id,{kind:'sell_settle',orderId:sell,amountCents:MAX_CENTS,idempotencyKey:'overflow-balance'})),ledgerError('overflow'));
  assert.equal((await reconcileWallet(db,id)).ledger.eventCount,'1');assert.equal((await reconcileWallet(db,other)).ledger.eventCount,'1');
});

test('request-key payload mismatch and an order movement under a new key are rejected',async()=>{
  const id=await member();await initializeWallet(db,id);const a=await order(id,'10000'),b=await order(id,'10000');
  await reserve(id,a,'stable-request');
  await assert.rejects(reserve(id,b,'stable-request'),ledgerError('conflict'));
  await assert.rejects(reserve(id,a,'different-request'),ledgerError('conflict'));
  const report=await reconcileWallet(db,id);assert.equal(report.ok,true);assert.equal(report.ledger.eventCount,'2');
});

test('reconciliation exposes transient drift while commit-time checks reject direct balance edits',async()=>{
  const id=await member();await initializeWallet(db,id);
  await db.transaction(async tx=>{
    await tx.execute(sql`UPDATE wallets SET available_cents=99999 WHERE user_id=${id}`);
    const report=await reconcileWallet(tx,id);assert.equal(report.ok,false);assert.ok(report.violations.includes('available_ledger_mismatch'));
    await tx.execute(sql`UPDATE wallets SET available_cents=100000 WHERE user_id=${id}`);
  });
  await assert.rejects(pool.query('UPDATE wallets SET available_cents=99999 WHERE user_id=$1',[id]),e=>e.code==='23514');
  assert.equal((await reconcileWallet(db,id)).ok,true);
});

test('starting grants remain append-only and a second grant cannot be committed',async()=>{
  const id=await member();await initializeWallet(db,id);
  await assert.rejects(pool.query("UPDATE ledger_events SET available_delta=1 WHERE user_id=$1",[id]),e=>e.code==='23514');
  await assert.rejects(pool.query("DELETE FROM ledger_events WHERE user_id=$1",[id]),e=>e.code==='23514');
  await assert.rejects(pool.query("INSERT INTO ledger_events(id,user_id,kind,idempotency_key,available_delta,reserved_delta) VALUES ($1,$2,'starting_grant','again',100000,0)",[randomUUID(),id]),e=>e.code==='23505');
  assert.equal((await reconcileWallet(db,id)).ledger.startingGrantCount,'1');
});
