import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { databaseClient } from './connection.mjs';

// Drizzle Kit is the only migration writer. Hold a separate session lock across
// its invocation so two release jobs cannot race the migrations journal.
const client = databaseClient();
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtextextended('first-press:migrations', 0))");
  const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  const hashes = new Set();
  for (const entry of journal.entries) {
    const sql = await readFile(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
    hashes.add(createHash('sha256').update(sql).digest('hex'));
  }
  const exists = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS table_name");
  if (exists.rows[0].table_name) {
    const applied = await client.query('SELECT hash FROM drizzle.__drizzle_migrations');
    if (applied.rows.some(row => !hashes.has(row.hash))) {
      throw new Error('Applied migration is missing or changed. Restore it and add a new forward migration.');
    }
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'migrate'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) throw new Error('Drizzle migration failed.');
  console.log('Database migrations are current.');
} catch (error) {
  // Driver errors can contain connection information; only our explicit messages are public.
  if (error instanceof Error && (error.message.startsWith('Applied migration') || error.message.startsWith('Drizzle migration'))) console.error(error.message);
  else console.error('Database migration could not complete. Check server connectivity/configuration.');
  process.exitCode = 1;
} finally {
  await client.end();
}
