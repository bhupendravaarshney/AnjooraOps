import fs from 'fs';
import path from 'path';
import './load-env.mjs';
import { REQUIRED_MIGRATIONS, missingRequiredMigrations } from '../lib/migrations.js';
const required = [
  'app/api/health/route.js',
  'app/api/v1/consultations/route.js',
  'app/api/v1/consent/route.js',
  'app/api/webhooks/whatsapp/route.js',
  'app/admin/page.js',
  'app/admin/staff/page.js',
  'app/api/admin/staff/route.js',
  'app/components/RecommendationFulfilmentFields.js',
  ...REQUIRED_MIGRATIONS.map((name) => `db/migrations/${name}`),
  'lib/bot.js',
  'lib/consultation-input.js',
  'lib/formula-ingredients.js',
  'lib/whatsapp.js'
];
let failed = false;
for (const rel of required) {
  if (!fs.existsSync(path.resolve(rel))) { console.error(`Missing: ${rel}`); failed = true; }
}
if (!process.env.CI && !process.env.DATABASE_URL) console.warn('DATABASE_URL not set; DB smoke test skipped.');
if (failed) process.exit(1);
if (process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) } : undefined,
  });
  await client.connect();
  try {
    const result = await client.query(`SELECT name FROM schema_migrations ORDER BY name`);
    const missing = missingRequiredMigrations(result.rows.map((row) => row.name));
    if (missing.length) throw new Error(`Required migrations have not all been applied: ${missing.join(', ')}.`);
    await client.query(`SELECT 1 FROM message_outbox LIMIT 1`);
    await client.query(`SELECT 1 FROM operational_job_runs LIMIT 1`);
    await client.query(`SELECT 1 FROM formula_ingredients LIMIT 1`);
  } finally { await client.end(); }
}
console.log('ANJOORA verification prerequisites passed.');
