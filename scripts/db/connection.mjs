import pg from 'pg';

export function databaseUrl(env = process.env) {
  const value = env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL is required for database commands. The local browser demo does not require it.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error('DATABASE_URL must identify a PostgreSQL host and database.');
  }
  return value;
}

export function databaseClient(env = process.env) {
  return new pg.Client({ connectionString: databaseUrl(env), connectionTimeoutMillis: 5000,
    application_name: 'first-press-maintenance', statement_timeout: 30000 });
}
