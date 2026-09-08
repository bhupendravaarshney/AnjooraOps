import crypto from 'crypto';
import pg from 'pg';
import './load-env.mjs';

const { Client } = pg;
const action = String(process.env.STAFF_ACTION || '').toLowerCase();
const email = String(process.env.STAFF_EMAIL || '').trim().toLowerCase();
const name = String(process.env.STAFF_NAME || '').trim() || 'ANJOORA Staff';
const role = String(process.env.STAFF_ROLE || 'SUPPORT').toUpperCase();
const password = String(process.env.STAFF_PASSWORD || '');
if (!['create', 'reset', 'deactivate'].includes(action) || !email) {
  throw new Error('Set STAFF_ACTION=create|reset|deactivate and STAFF_EMAIL.');
}
if (!['ADMIN', 'VAIDYA', 'OPERATIONS', 'SUPPORT'].includes(role)) throw new Error('Invalid STAFF_ROLE.');
if (action !== 'deactivate' && (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password))) {
  throw new Error('STAFF_PASSWORD must be 12+ characters with uppercase, lowercase, number, and symbol.');
}
function passwordHash() {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n') } : undefined,
});
await client.connect();
try {
  await client.query('BEGIN');
  let user;
  if (action === 'create') {
    user = (await client.query(`
      INSERT INTO staff_users(id,email,name,password_hash,role,must_rotate_password)
      VALUES($1,$2,$3,$4,$5,true) RETURNING id
    `, [crypto.randomUUID(), email, name, passwordHash(), role])).rows[0];
  } else {
    user = (await client.query(`SELECT id FROM staff_users WHERE email=$1 FOR UPDATE`, [email])).rows[0];
    if (!user) throw new Error('Staff account not found.');
    if (action === 'reset') {
      await client.query(`UPDATE staff_users SET password_hash=$1,must_rotate_password=true,failed_login_count=0,locked_until=NULL,updated_at=now() WHERE id=$2`, [passwordHash(), user.id]);
    } else {
      await client.query(`UPDATE staff_users SET active=false,updated_at=now() WHERE id=$1`, [user.id]);
    }
    await client.query(`DELETE FROM sessions WHERE staff_user_id=$1`, [user.id]);
  }
  await client.query(`INSERT INTO audit_events(id,entity_type,entity_id,action,payload) VALUES($1,'STAFF_USER',$2,$3,$4::jsonb)`, [crypto.randomUUID(), user.id, `CLI_${action.toUpperCase()}`, JSON.stringify({ email_hash: crypto.createHash('sha256').update(email).digest('hex') })]);
  await client.query('COMMIT');
  console.log(`Staff action ${action} completed for ${email}.`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
