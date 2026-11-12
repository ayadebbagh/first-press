import 'server-only';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

let connection: ReturnType<typeof createConnection> | undefined;
function createConnection() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Server DATABASE_URL is not configured.');
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000, statement_timeout: 15000, lock_timeout: 5000,
    application_name: 'first-press-web' });
  // Avoid logging connection details or user queries from idle connection errors.
  pool.on('error', () => { console.error('Database idle connection failed.'); });
  return { db: drizzle(pool, { schema }), pool };
}
// Lazy: a static build and the standalone demo never require a live database.
export function getDatabase() {
  connection ??= createConnection();
  return connection.db;
}
export async function closeDatabase() {
  if (!connection) return;
  await connection.pool.end();
  connection = undefined;
}
