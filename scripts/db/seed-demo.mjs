import { databaseClient } from './connection.mjs';
const client = databaseClient();
try {
  if (process.env.ALLOW_DEMO_SEED !== 'true') throw new Error('Explicit ALLOW_DEMO_SEED=true is required.');
  await client.connect();
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('first-press:demo-seed', 0))");
  const { rows: [db] } = await client.query('SELECT current_database() AS name');
  if (!db.name.endsWith('_demo')) throw new Error('Demo seed requires a separate database whose name ends with _demo.');
  const { rows: identity } = await client.query('SELECT purpose FROM database_identity');
  if (identity.length && identity[0].purpose !== 'demo') throw new Error('Database is not classified as demo.');
  if (!identity.length) {
    const { rows: [existing] } = await client.query('SELECT (SELECT count(*) FROM "user") + (SELECT count(*) FROM artists) + (SELECT count(*) FROM wallets) AS total');
    if (existing.total !== '0') throw new Error('Refusing to classify an occupied database as demo.');
    await client.query("INSERT INTO database_identity (purpose) VALUES ('demo')");
  }
  await client.query(`INSERT INTO artists (id, slug, name, spotify_artist_id, status, synthetic)
    VALUES ('demo-artist', 'synthetic-demo-artist', 'SYNTHETIC — Demo Artist', '0000000000000000000000', 'review', true)
    ON CONFLICT (id) DO NOTHING`);
  await client.query(`INSERT INTO listener_snapshots
    (id, artist_id, status, listener_count, source_url, source_event_key, evidence, parser_version, observed_at, fetched_at, accepted_at, reviewed_by, synthetic)
    VALUES ('demo-observation', 'demo-artist', 'accepted', 10000, 'https://example.invalid/synthetic', 'demo-v1', '{"synthetic":true}', 'demo-v1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 'synthetic-fixture', true)
    ON CONFLICT (id) DO NOTHING`);
  await client.query('COMMIT');
  console.log('Isolated synthetic demo fixture is ready. No accounts, grants or receipts were created.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof Error && /demo|occupied|ALLOW_DEMO_SEED/.test(error.message) ? error.message : 'Demo seed failed; no changes committed.');
  process.exitCode = 1;
} finally { await client.end(); }
