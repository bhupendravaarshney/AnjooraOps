import crypto from 'crypto';
import pg from 'pg';
import './load-env.mjs';

const { Client } = pg;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !password) {
  console.log('Bootstrap admin skipped: BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set.');
  process.exit(0);
}
if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
  throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be 12+ characters with uppercase, lowercase, number, and symbol.');
}
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const passwordHash = `${salt}:${hash}`;
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) } : undefined });
await client.connect();
try {
  await client.query(`
    INSERT INTO staff_users (id,email,name,password_hash,role,must_rotate_password)
    VALUES ($1,$2,$3,$4,'ADMIN',true)
    ON CONFLICT (email) DO NOTHING
    RETURNING id
  `, [crypto.randomUUID(), email.toLowerCase(), 'ANJOORA Admin', passwordHash]);
  console.log(`Bootstrap admin checked: ${email}. Existing credentials were not changed.`);
} finally { await client.end(); }
