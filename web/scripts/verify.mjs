import fs from 'fs';
import path from 'path';
import './load-env.mjs';
const required = [
  'app/api/health/route.js',
  'app/api/v1/consultations/route.js',
  'app/api/webhooks/whatsapp/route.js',
  'app/admin/page.js',
  'db/migrations/001_init.sql',
  'db/migrations/002_multi_concern_safety.sql',
  'db/migrations/003_operational_hardening.sql',
  'db/migrations/004_followup_constraints.sql',
  'db/migrations/005_operational_pagination.sql',
  'db/migrations/006_messaging_lookup_indexes.sql',
  'lib/bot.js',
  'lib/consultation-input.js',
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
    const result = await client.query(`SELECT count(*)::int count FROM schema_migrations`);
    if (result.rows[0].count < 6) throw new Error('Required migrations have not all been applied.');
    await client.query(`SELECT 1 FROM message_outbox LIMIT 1`);
  } finally { await client.end(); }
}
console.log('ANJOORA verification prerequisites passed.');
