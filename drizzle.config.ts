import { defineConfig } from 'drizzle-kit';
// Never fall back to a shared/demo connection. Generate does not need a URL.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
});
