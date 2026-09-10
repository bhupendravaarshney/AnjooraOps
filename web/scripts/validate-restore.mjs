import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import './load-env.mjs';
import { missingRequiredMigrations } from '../lib/migrations.js';

const { Client } = pg;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for a restore drill.`);
  return value;
}

function timestamp(name) {
  const raw = required(name);
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error(`${name} must be an ISO-8601 timestamp.`);
  return value;
}

function positiveNumber(name) {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function databaseIdentity(url) {
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
}

if (process.env.RESTORE_CONFIRM_ISOLATED !== 'true') {
  throw new Error('Set RESTORE_CONFIRM_ISOLATED=true only after confirming the restored database is isolated from production.');
}
const restoreUrl = new URL(required('RESTORE_DATABASE_URL'));
if (!['postgres:', 'postgresql:'].includes(restoreUrl.protocol)) throw new Error('RESTORE_DATABASE_URL must be a PostgreSQL URL.');
const sourceUrl = new URL(required('DATABASE_URL'));
if (!['postgres:', 'postgresql:'].includes(sourceUrl.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL.');
if (databaseIdentity(sourceUrl) === databaseIdentity(restoreUrl)) {
  throw new Error('RESTORE_DATABASE_URL resolves to the source database; validation must use an isolated restore.');
}

const backupTimestamp = timestamp('RESTORE_BACKUP_TIMESTAMP');
const targetTimestamp = timestamp('RESTORE_TARGET_TIMESTAMP');
const restoreStartedAt = timestamp('RESTORE_STARTED_AT');
const operator = required('RESTORE_OPERATOR');
if (operator.length < 2 || operator.length > 120) throw new Error('RESTORE_OPERATOR must identify the named operator in 2-120 characters.');
const rpoHours = positiveNumber('BACKUP_RPO_HOURS');
const rtoMinutes = positiveNumber('BACKUP_RTO_MINUTES');
const preflightAt = new Date();
if (backupTimestamp > targetTimestamp) throw new Error('RESTORE_BACKUP_TIMESTAMP cannot be after RESTORE_TARGET_TIMESTAMP.');
if (targetTimestamp > preflightAt) throw new Error('RESTORE_TARGET_TIMESTAMP cannot be in the future.');
if (restoreStartedAt > preflightAt) throw new Error('RESTORE_STARTED_AT cannot be in the future.');
if (restoreStartedAt < targetTimestamp) throw new Error('RESTORE_STARTED_AT cannot be before the requested restore target.');

const sslEnabled = (process.env.RESTORE_DATABASE_SSL || process.env.DATABASE_SSL) === 'true';
if (!sslEnabled && !['localhost', '127.0.0.1', '::1'].includes(restoreUrl.hostname.toLowerCase())) {
  throw new Error('Remote restored databases require RESTORE_DATABASE_SSL=true with certificate verification.');
}
const sslMode = restoreUrl.searchParams.get('sslmode');
if (sslEnabled && sslMode && sslMode !== 'verify-full') {
  throw new Error('RESTORE_DATABASE_URL sslmode must be verify-full when supplied.');
}
const ca = process.env.RESTORE_DATABASE_CA_CERT || process.env.DATABASE_CA_CERT;
const client = new Client({
  connectionString: restoreUrl.toString(),
  ssl: sslEnabled ? { rejectUnauthorized: true, ...(ca ? { ca: ca.replace(/\\n/g, '\n') } : {}) } : undefined,
});

let validation;
await client.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const structure = (await client.query(`
    SELECT
      current_database() database_name,
      ARRAY(SELECT name FROM schema_migrations ORDER BY name) migration_names,
      to_regclass('public.customers') IS NOT NULL customers_table,
      to_regclass('public.consultations') IS NOT NULL consultations_table,
      to_regclass('public.orders') IS NOT NULL orders_table,
      to_regclass('public.message_outbox') IS NOT NULL outbox_table,
      to_regclass('public.operational_job_runs') IS NOT NULL job_runs_table,
      to_regclass('public.inventory_stock') IS NOT NULL inventory_view,
      to_regclass('public.audit_events') IS NOT NULL audit_table
  `)).rows[0];
  const counts = (await client.query(`
    SELECT
      (SELECT count(*)::int FROM customers) customers,
      (SELECT count(*)::int FROM consultations) consultations,
      (SELECT count(*)::int FROM orders) orders,
      (SELECT count(*)::int FROM inventory_items) inventory_items,
      (SELECT count(*)::int FROM audit_events) audit_events,
      (SELECT count(*)::int FROM message_outbox) outbox_jobs
  `)).rows[0];
  await client.query('COMMIT');
  validation = { structure, counts };
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}

const requiredStructure = ['customers_table', 'consultations_table', 'orders_table', 'outbox_table', 'job_runs_table', 'inventory_view', 'audit_table'];
const missingMigrations = missingRequiredMigrations(validation.structure.migration_names);
if (missingMigrations.length || requiredStructure.some((key) => validation.structure[key] !== true)) {
  throw new Error(`Restored database failed structural validation: ${JSON.stringify(validation.structure)}`);
}
if (process.env.RESTORE_REQUIRE_REPRESENTATIVE_DATA === 'true') {
  const missing = ['customers', 'consultations', 'orders', 'inventory_items', 'audit_events']
    .filter((key) => Number(validation.counts[key]) < 1);
  if (missing.length) throw new Error(`Restore lacks representative production-like data in: ${missing.join(', ')}.`);
}

const validatedAt = new Date();
const rpoActualHours = (targetTimestamp.getTime() - backupTimestamp.getTime()) / 3_600_000;
const rtoActualMinutes = (validatedAt.getTime() - restoreStartedAt.getTime()) / 60_000;
if (rpoActualHours > rpoHours) throw new Error(`Restore missed RPO: ${rpoActualHours.toFixed(2)}h actual > ${rpoHours}h approved.`);
if (rtoActualMinutes > rtoMinutes) throw new Error(`Restore missed RTO: ${rtoActualMinutes.toFixed(2)}m actual > ${rtoMinutes}m approved.`);

const evidence = {
  evidence_version: 1,
  result: 'PASSED',
  validated_at: validatedAt.toISOString(),
  operator,
  database_name: validation.structure.database_name,
  source_identity_distinct: true,
  restore_tls_verified: sslEnabled,
  backup_timestamp: backupTimestamp.toISOString(),
  target_timestamp: targetTimestamp.toISOString(),
  restore_started_at: restoreStartedAt.toISOString(),
  rpo: { approved_hours: rpoHours, actual_hours: Number(rpoActualHours.toFixed(3)) },
  rto: { approved_minutes: rtoMinutes, actual_minutes: Number(rtoActualMinutes.toFixed(2)) },
  migrations: validation.structure.migration_names,
  row_counts: validation.counts,
  representative_data_required: process.env.RESTORE_REQUIRE_REPRESENTATIVE_DATA === 'true',
};
if (process.env.RESTORE_EVIDENCE_FILE) {
  const evidenceFile = path.resolve(process.env.RESTORE_EVIDENCE_FILE);
  await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(`Restore evidence written to ${evidenceFile}.`);
}
console.log(JSON.stringify(evidence, null, 2));
