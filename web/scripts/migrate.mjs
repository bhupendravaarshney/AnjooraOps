import fs from 'fs/promises';
import path from 'path';
import pg from 'pg';
import { fileURLToPath } from 'url';
import './load-env.mjs';

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../db/migrations');
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) } : undefined,
});

await client.connect();
try {
  await client.query(`SELECT pg_advisory_lock(hashtext('anjoora-ops-schema-migrations'))`);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await fs.readdir(migrationsDir)).filter((x) => x.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file]);
    if (done.rowCount) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied migration ${file}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
} finally {
  await client.query(`SELECT pg_advisory_unlock(hashtext('anjoora-ops-schema-migrations'))`).catch(() => {});
  await client.end();
}
