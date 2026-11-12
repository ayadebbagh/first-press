import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

// Never infer a test target from the application's DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must explicitly identify a disposable _test database.');
const client = new pg.Client({ connectionString: url });
const command = (file, extra = {}, args = []) => spawnSync(process.execPath, [file, ...args], {
  env: { ...process.env, DATABASE_URL: url, ...extra }, encoding: 'utf8', timeout: 60000,
});
const migration = extra => command('scripts/db/migrate.mjs', extra);
const mustPass = r => assert.equal(r.status, 0, r.stdout + r.stderr);
const query = (sql, values) => client.query(sql, values);
const rejected = async (sql, values, code = '23514') => {
  await query('SAVEPOINT invalid_operation');
  try { await assert.rejects(query(sql, values), e => e.code === code); }
  finally { await query('ROLLBACK TO SAVEPOINT invalid_operation'); }
};
async function transaction(fn) {
  await query('BEGIN');
  try { await fn(); } finally { await query('ROLLBACK'); }
}
async function fixture() {
  await query(`INSERT INTO "user" (id,name,email) VALUES ('alice','Alice','alice@example.invalid'),('bob','Bob','bob@example.invalid')`);
  await query(`INSERT INTO wallets (user_id) VALUES ('alice'),('bob')`);
  await query(`INSERT INTO artists (id,slug,name,spotify_artist_id,status) VALUES ('artist','artist','Artist','1111111111111111111111','active'),('other','other','Other','2222222222222222222222','active')`);
  await query(`INSERT INTO listener_snapshots (id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by) VALUES
    ('baseline','artist','accepted',10000,'https://example.invalid/artist','baseline','{}','test','2026-01-01T10:00Z','2026-01-01T10:01Z','2026-01-01T10:02Z','test'),
    ('execution','artist','accepted',11000,'https://example.invalid/artist','execution','{}','test','2026-01-01T12:05Z','2026-01-01T12:05Z','2026-01-01T12:06Z','test')`);
}
async function buy(id = 'buy', user = 'alice', amount = '10001') {
  await query(`INSERT INTO orders (id,user_id,artist_id,side,amount_cents,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff)
    VALUES ($1,$2,'artist','buy',$3,$1,repeat('a',64),'baseline','2026-01-01T11:00Z','2026-01-01T12:00Z')`, [id,user,amount]);
}
async function settledLot() {
  await buy();
  await query(`INSERT INTO settlement_batches (id,artist_id,cutoff,sealed_at,eligible_through,status,snapshot_id,executed_at) VALUES
    ('batch','artist','2026-01-01T12:00Z','2026-01-01T12:01Z','2026-01-01T11:59:59.999Z','sealed',NULL,NULL)`);
  await query(`UPDATE settlement_batches SET status='executed',snapshot_id='execution',executed_at='2026-01-01T12:07Z' WHERE id='batch'`);
  await query(`UPDATE orders SET status='settled',settled_at='2026-01-01T12:07Z' WHERE id='buy'`);
  await query(`INSERT INTO settlements (order_id,user_id,artist_id,batch_id,executed_at,cash_cents) VALUES ('buy','alice','artist','batch','2026-01-01T12:07Z',10001)`);
  await query(`INSERT INTO position_lots (id,buy_order_id,user_id,artist_id,entry_snapshot_id,principal_cents,entry_listener_count,created_at)
    VALUES ('lot','buy','alice','artist','execution',10001,11000,'2026-01-01T12:07Z')`);
}

before(async () => { mustPass(migration()); await client.connect(); });
after(async () => { await client.end(); });

test('empty database migrations replay safely and all stored instants are timezone-aware', async () => {
  mustPass(migration());
  assert.equal((await query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, 2);
  const wrong = await query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='timestamp without time zone'`);
  assert.deepEqual(wrong.rows, []);
  const pending = await query('SELECT count(*)::int AS n FROM artists');
  assert.equal(pending.rows[0].n, 0, 'migrations must not silently seed demo/catalog data');
});

test('changed applied migrations are rejected before a release can continue', async () => {
  const path = 'drizzle/0000_foundation.sql'; const original = await readFile(path, 'utf8');
  try {
    await writeFile(path, original + '\n-- unexpected edit\n');
    const result = migration(); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Applied migration is missing or changed/);
  } finally { await writeFile(path, original); }
});

test('simultaneous migration invocations serialize and remain repeatable', async () => {
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/db/migrate.mjs'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    let output=''; child.stdout.on('data',x=>output+=x); child.stderr.on('data',x=>output+=x);
    child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(new Error(output)));
  });
  await Promise.all([run(),run()]);
});

test('wallets and starting grants use exact bounded amounts and unique account grants', () => transaction(async () => {
  await fixture();
  await query(`UPDATE wallets SET available_cents=9223372036854775807 WHERE user_id='alice'`);
  assert.equal((await query("SELECT available_cents FROM wallets WHERE user_id='alice'")).rows[0].available_cents, '9223372036854775807');
  await rejected(`UPDATE wallets SET reserved_cents=1 WHERE user_id='alice'`);
  await rejected(`UPDATE wallets SET available_cents=-1 WHERE user_id='bob'`);
  await query(`INSERT INTO ledger_events (id,user_id,kind,idempotency_key,available_delta,reserved_delta) VALUES ('grant','alice','starting_grant','initial',100000,0)`);
  await rejected(`INSERT INTO ledger_events (id,user_id,kind,idempotency_key,available_delta,reserved_delta) VALUES ('again','alice','starting_grant','new-key',100000,0)`, [], '23505');
  await rejected(`UPDATE ledger_events SET available_delta=1 WHERE id='grant'`);
  await rejected(`DELETE FROM ledger_events WHERE id='grant'`);
}));

test('accepted observations reject zero/missing counts, preserve provenance and remain append-only', () => transaction(async () => {
  await fixture();
  const insert = `INSERT INTO listener_snapshots (id,artist_id,status,listener_count,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at,accepted_at,reviewed_by) VALUES ('bad','artist','accepted',$1,'https://example.invalid','bad','{}','test','2026-01-01T12:00Z','2026-01-01T12:01Z','2026-01-01T12:02Z','test')`;
  for (const count of [null, '0', '-1', '1000000000001']) await rejected(insert, [count]);
  await rejected(`UPDATE listener_snapshots SET listener_count=500 WHERE id='baseline'`);
  await rejected(`DELETE FROM listener_snapshots WHERE id='baseline'`);
  assert.equal((await query("SELECT source_updated_at FROM listener_snapshots WHERE id='baseline'")).rows[0].source_updated_at, null);
}));

test('order requests are unique per account; missing intent and wrong baselines cannot pass SQL NULL checks', () => transaction(async () => {
  await fixture(); await buy();
  await rejected(`INSERT INTO orders SELECT 'duplicate',user_id,artist_id,side,status,amount_cents,exit_basis_points,request_key,request_hash,economy_version,placement_snapshot_id,accepted_at,earliest_cutoff,cancelled_at,settled_at FROM orders WHERE id='buy'`, [], '23505');
  await rejected(`INSERT INTO orders (id,user_id,artist_id,side,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff) VALUES ('empty','alice','artist','buy','empty',repeat('a',64),'baseline','2026-01-01T11:00Z','2026-01-01T12:00Z')`);
  await rejected(`INSERT INTO orders (id,user_id,artist_id,side,amount_cents,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff) VALUES ('wrong','alice','other','buy',100,'wrong',repeat('a',64),'baseline','2026-01-01T11:00Z','2026-01-01T12:00Z')`);
  await rejected(`UPDATE orders SET amount_cents=100 WHERE id='buy'`);
  await rejected(`UPDATE orders SET status='cancelled' WHERE id='buy'`);
  await query(`UPDATE orders SET status='cancelled',cancelled_at='2026-01-01T11:01Z' WHERE id='buy'`);
  await rejected(`UPDATE orders SET status='queued',cancelled_at=NULL WHERE id='buy'`);
}));

test('cash reservation ownership and exact intent are enforced', () => transaction(async () => {
  await fixture(); await buy();
  await rejected(`INSERT INTO cash_reservations (order_id,user_id,artist_id,amount_cents) VALUES ('buy','bob','artist',10001)`, [], '23503');
  await rejected(`INSERT INTO cash_reservations (order_id,user_id,artist_id,amount_cents) VALUES ('buy','alice','artist',100)`);
  await query(`INSERT INTO cash_reservations (order_id,user_id,artist_id,amount_cents) VALUES ('buy','alice','artist',10001)`);
  await rejected(`UPDATE cash_reservations SET status='released' WHERE order_id='buy'`);
}));

test('a receipt requires a settled buy lot and preserves placement and execution observations', () => transaction(async () => {
  await fixture(); await buy('pending');
  await rejected(`INSERT INTO receipt_events (id,lot_id) VALUES ('premature','missing')`, [], '23503');
  await settledLot();
  await query(`INSERT INTO receipt_events (id,lot_id) VALUES ('receipt','lot')`);
  const { rows: [receipt] } = await query(`SELECT o.accepted_at,x.executed_at,p.listener_count AS placement_count,e.listener_count AS execution_count
    FROM receipt_events r JOIN position_lots l ON l.id=r.lot_id JOIN orders o ON o.id=l.buy_order_id
    JOIN settlements x ON x.order_id=o.id JOIN listener_snapshots p ON p.id=o.placement_snapshot_id
    JOIN listener_snapshots e ON e.id=l.entry_snapshot_id WHERE r.id='receipt'`);
  assert.equal(receipt.accepted_at.toISOString(), '2026-01-01T11:00:00.000Z');
  assert.equal(receipt.executed_at.toISOString(), '2026-01-01T12:07:00.000Z');
  assert.equal(receipt.placement_count, '10000'); assert.equal(receipt.execution_count, '11000');
  await rejected(`INSERT INTO settlements SELECT * FROM settlements WHERE order_id='buy'`, [], '23505');
  await rejected(`UPDATE position_lots SET entry_listener_count=1 WHERE id='lot'`);
  await rejected(`UPDATE receipt_events SET created_at=now() WHERE id='receipt'`);
  await rejected(`DELETE FROM position_lots WHERE id='lot'`);
  await rejected(`UPDATE settlement_batches SET snapshot_id='baseline' WHERE id='batch'`);
}));

test('lot quantities are bounded and remainders exceed bigint without losing precision', () => transaction(async () => {
  await fixture(); await settledLot();
  await rejected(`UPDATE position_lots SET reserved_quanta=1000000000001 WHERE id='lot'`);
  await rejected(`UPDATE position_lots SET remaining_quanta=-1 WHERE id='lot'`);
  // Existing lot denominator 11,000 * 10^12 = 1.1e16; precision checked separately at SQL maximum.
  const result = await query(`SELECT (9223372036854775807::numeric * 1000000000000::numeric * 1000000000000::numeric)::numeric(60,0) AS product`);
  assert.equal(result.rows[0].product, '9223372036854775807000000000000000000000000');
  await query(`UPDATE position_lots SET proceeds_remainder=10999999999999999 WHERE id='lot'`);
  assert.equal((await query("SELECT proceeds_remainder FROM position_lots WHERE id='lot'")).rows[0].proceeds_remainder, '10999999999999999');
  await rejected(`UPDATE position_lots SET proceeds_remainder=11000000000000000 WHERE id='lot'`);
}));

test('pending exits cannot allocate another member’s lots', () => transaction(async () => {
  await fixture(); await settledLot();
  await query(`INSERT INTO orders (id,user_id,artist_id,side,exit_basis_points,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff) VALUES
    ('sell','bob','artist','sell',10000,'sell',repeat('b',64),'execution','2026-01-01T13:00Z','2026-01-02T00:00Z')`);
  await rejected(`INSERT INTO exit_allocations (order_id,lot_id,user_id,artist_id,quanta) VALUES ('sell','lot','bob','artist',1)`, [], '23503');
}));

test('schema allows cancellation during an artist suspension but refuses new orders', () => transaction(async () => {
  await fixture(); await buy();
  await query(`UPDATE artists SET status='suspended' WHERE id='artist'`);
  await rejected(`INSERT INTO orders (id,user_id,artist_id,side,amount_cents,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff) VALUES ('new','alice','artist','buy',100,'new',repeat('a',64),'baseline','2026-01-01T11:01Z','2026-01-01T12:00Z')`);
  await query(`UPDATE orders SET status='cancelled',cancelled_at='2026-01-01T11:02Z' WHERE id='buy'`);
}));

test('demo seed is explicit, isolated, synthetic and safely repeatable', async () => {
  assert.notEqual(command('scripts/db/seed-demo.mjs', { ALLOW_DEMO_SEED: '' }).status, 0);
  assert.notEqual(command('scripts/db/seed-demo.mjs', { ALLOW_DEMO_SEED: 'true' }).status, 0);
  const name = 'first_press_' + randomUUID().replaceAll('-','') + '_demo';
  const demoUrl = new URL(url); demoUrl.pathname = '/' + name;
  const demo = new pg.Client({ connectionString: demoUrl.toString() });
  await query(`CREATE DATABASE "${name}"`);
  try {
    mustPass(migration({ DATABASE_URL: demoUrl.toString() }));
    for (let i=0;i<2;i++) mustPass(command('scripts/db/seed-demo.mjs', { DATABASE_URL: demoUrl.toString(), ALLOW_DEMO_SEED: 'true' }));
    await demo.connect();
    assert.equal((await demo.query('SELECT count(*)::int AS n FROM artists WHERE synthetic')).rows[0].n, 1);
    await assert.rejects(demo.query("UPDATE database_identity SET purpose='live'"), e=>e.code==='23514');
    for (const table of ['user','wallets','ledger_events','receipt_events']) assert.equal((await demo.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n, 0);
  } finally { await demo.end(); await query(`DROP DATABASE "${name}"`); }
});

test('quarantined, future and stale placement baselines cannot admit an order', () => transaction(async () => {
  await fixture();
  await query(`INSERT INTO listener_snapshots (id,artist_id,status,source_url,source_event_key,evidence,parser_version,observed_at,fetched_at)
    VALUES ('quarantine','artist','quarantined','https://example.invalid','quarantine','{"raw":"unreadable"}','test','2026-01-01T10:00Z','2026-01-01T10:01Z')`);
  const insert = `INSERT INTO orders (id,user_id,artist_id,side,amount_cents,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff)
    VALUES ('invalid','alice','artist','buy',100,'invalid',repeat('a',64),$1,$2,$3)`;
  await rejected(insert, ['quarantine','2026-01-01T11:00Z','2026-01-01T12:00Z']);
  await rejected(insert, ['baseline','2026-01-01T09:00Z','2026-01-01T12:00Z']);
  await rejected(insert, ['baseline','2026-01-03T11:00Z','2026-01-03T12:00Z']);
}));

test('batch guards reject expired quotes, reused observations and orders at the strict cutoff', () => transaction(async () => {
  await fixture();
  await query(`INSERT INTO settlement_batches (id,artist_id,cutoff,sealed_at,eligible_through)
    VALUES ('batch','artist','2026-01-01T12:00Z','2026-01-01T12:01Z','2026-01-01T11:59:59.999Z')`);
  await rejected(`UPDATE settlement_batches SET status='executed',snapshot_id='execution',executed_at='2026-01-01T14:00Z' WHERE id='batch'`);
  await rejected(`UPDATE settlement_batches SET status='executed',snapshot_id='baseline',executed_at='2026-01-01T12:07Z' WHERE id='batch'`);
  await query(`UPDATE settlement_batches SET status='executed',snapshot_id='execution',executed_at='2026-01-01T12:07Z' WHERE id='batch'`);
  await query(`INSERT INTO orders (id,user_id,artist_id,side,amount_cents,request_key,request_hash,placement_snapshot_id,accepted_at,earliest_cutoff)
    VALUES ('boundary','alice','artist','buy',100,'boundary',repeat('c',64),'baseline','2026-01-01T12:00Z','2026-01-02T00:00Z')`);
  await query(`UPDATE orders SET status='settled',settled_at='2026-01-01T12:07Z' WHERE id='boundary'`);
  await rejected(`INSERT INTO settlements (order_id,user_id,artist_id,batch_id,executed_at,cash_cents)
    VALUES ('boundary','alice','artist','batch','2026-01-01T12:07Z',100)`);
}));
