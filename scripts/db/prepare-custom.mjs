import { readFile, writeFile } from 'node:fs/promises';
const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'));
const tag = journal.entries.at(-1).tag;
if (!tag.endsWith('_integrity')) throw new Error('Expected a freshly generated integrity migration.');
await writeFile(`drizzle/${tag}.sql`, await readFile('scripts/db/integrity.sql'));
const sql = await readFile('drizzle/0000_foundation.sql','utf8');
if (!sql.includes('CREATE TABLE')) throw new Error('Foundation migration was not generated.');
