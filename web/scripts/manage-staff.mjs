import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import './load-env.mjs';
import { hashPassword, passwordPolicyError } from '../lib/security.js';
import {
  normalizeStaffEmail,
  normalizeStaffName,
  normalizeStaffRole,
  staffComplianceFindings,
} from '../lib/staff-policy.js';

const { Client } = pg;
const ACTIONS = new Set(['list', 'audit', 'create', 'update', 'reset', 'recover', 'deactivate']);
const action = String(process.env.STAFF_ACTION || '').trim().toLowerCase();
if (!ACTIONS.has(action)) {
  throw new Error(`Set STAFF_ACTION to one of ${[...ACTIONS].join(', ')}.`);
}

const needsEmail = !['list', 'audit'].includes(action);
const email = needsEmail ? normalizeStaffEmail(process.env.STAFF_EMAIL) : null;
const needsNameAndRole = ['create', 'update'].includes(action);
const name = needsNameAndRole ? normalizeStaffName(process.env.STAFF_NAME) : null;
const role = needsNameAndRole ? normalizeStaffRole(process.env.STAFF_ROLE) : null;
const needsPassword = ['create', 'reset', 'recover'].includes(action);
const password = needsPassword ? String(process.env.STAFF_PASSWORD || '') : null;
if (needsPassword) {
  const policyError = passwordPolicyError(password);
  if (policyError) throw new Error(`STAFF_PASSWORD: ${policyError}`);
}
const mutation = !['list', 'audit'].includes(action);
const operator = mutation ? String(process.env.STAFF_OPERATOR || '').trim() : null;
if (mutation && !/^[A-Za-z0-9][A-Za-z0-9 ._@:/+-]{1,119}$/.test(operator)) {
  throw new Error('STAFF_OPERATOR must identify the named administrator performing this change (2-120 characters).');
}
const recoveryApproval = action === 'recover' ? String(process.env.STAFF_RECOVERY_APPROVAL_REF || '').trim() : null;
if (action === 'recover' && !/^[A-Za-z0-9][A-Za-z0-9 ._:/+-]{2,159}$/.test(recoveryApproval)) {
  throw new Error('STAFF_RECOVERY_APPROVAL_REF must identify the approved recovery record (3-160 characters).');
}

function connectionOptions() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (process.env.NODE_ENV === 'production' && process.env.DEPLOYMENT_PROFILE !== 'local' && process.env.DATABASE_SSL !== 'true') {
    throw new Error('Production staff management requires DATABASE_SSL=true with certificate verification.');
  }
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) }
      : undefined,
  };
}

async function loadExpectedRegister() {
  const configured = String(process.env.STAFF_REGISTER_FILE || '').trim();
  if (!configured) return null;
  const filename = path.resolve(configured);
  let raw;
  try { raw = await fs.readFile(filename, 'utf8'); } catch (error) {
    throw new Error(`Could not read STAFF_REGISTER_FILE ${filename}: ${error.message}`);
  }
  try { return JSON.parse(raw); } catch {
    throw new Error(`STAFF_REGISTER_FILE ${filename} is not valid JSON.`);
  }
}

async function staffRows(client) {
  return (await client.query(`
    SELECT id,email,name,role,active,must_rotate_password,mfa_enabled,
           password_changed_at,last_login_at,created_at,updated_at
    FROM staff_users
    ORDER BY active DESC,lower(email),id
  `)).rows;
}

function printableRows(rows) {
  return rows.map((row) => ({
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active,
    password_rotated: !row.must_rotate_password,
    mfa: row.mfa_enabled,
    last_login_at: row.last_login_at ? new Date(row.last_login_at).toISOString() : 'never',
  }));
}

const client = new Client(connectionOptions());
await client.connect();
try {
  if (action === 'list' || action === 'audit') {
    const rows = await staffRows(client);
    console.table(printableRows(rows));
    if (action === 'audit') {
      const expectedRegister = await loadExpectedRegister();
      const findings = staffComplianceFindings(rows, {
        expectedRegister,
        requireMfa: process.env.REQUIRE_STAFF_MFA === 'true',
      });
      if (!expectedRegister) {
        findings.push('STAFF_REGISTER_FILE is not set, so the active accounts cannot be compared with the approved production register.');
      }
      if (findings.length) {
        console.error('Staff compliance audit failed:');
        for (const finding of findings) console.error(`- ${finding}`);
        process.exitCode = 1;
      } else {
        console.log('Staff compliance audit passed: the active database accounts exactly match the approved register, with rotated passwords and MFA.');
      }
    }
  } else {
    await client.query('BEGIN');
    try {
      let user;
      if (action === 'create') {
        user = (await client.query(`
          INSERT INTO staff_users(id,email,name,password_hash,role,active,must_rotate_password,mfa_enabled,mfa_secret_encrypted)
          VALUES($1,$2,$3,$4,$5,true,true,false,NULL)
          RETURNING id
        `, [crypto.randomUUID(), email, name, hashPassword(password), role])).rows[0];
      } else {
        user = (await client.query(`SELECT id FROM staff_users WHERE email=$1 FOR UPDATE`, [email])).rows[0];
        if (!user) throw new Error('Staff account not found.');
        if (action === 'update') {
          await client.query(`UPDATE staff_users SET name=$1,role=$2,updated_at=now() WHERE id=$3`, [name, role, user.id]);
        } else if (action === 'reset') {
          await client.query(`
            UPDATE staff_users SET password_hash=$1,must_rotate_password=true,
              failed_login_count=0,locked_until=NULL,updated_at=now()
            WHERE id=$2
          `, [hashPassword(password), user.id]);
        } else if (action === 'recover') {
          await client.query(`
            UPDATE staff_users SET password_hash=$1,active=true,must_rotate_password=true,
              mfa_enabled=false,mfa_secret_encrypted=NULL,failed_login_count=0,
              locked_until=NULL,updated_at=now()
            WHERE id=$2
          `, [hashPassword(password), user.id]);
        } else if (action === 'deactivate') {
          await client.query(`UPDATE staff_users SET active=false,updated_at=now() WHERE id=$1`, [user.id]);
        }
        await client.query(`DELETE FROM sessions WHERE staff_user_id=$1`, [user.id]);
      }
      await client.query(`
        INSERT INTO audit_events(id,entity_type,entity_id,action,payload)
        VALUES($1,'STAFF_USER',$2,$3,$4::jsonb)
      `, [
        crypto.randomUUID(), user.id, `CLI_${action.toUpperCase()}`,
        JSON.stringify({
          email_hash: crypto.createHash('sha256').update(email).digest('hex'),
          operator,
          ...(recoveryApproval ? { recovery_approval_ref: recoveryApproval } : {}),
          ...(role ? { role } : {}),
          sessions_revoked: action !== 'create',
        }),
      ]);
      await client.query('COMMIT');
      console.log(`Staff action ${action} completed for ${email}.`);
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') throw new Error('A staff account with that email already exists.');
      throw error;
    }
  }
} finally {
  await client.end();
}
