import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import './validate-env.mjs';
import { parseStaffRegister, staffComplianceFindings } from '../lib/staff-policy.js';
import { backlogIssues, jobFreshnessIssues } from '../lib/operations-status.js';
import { releaseEvidenceFindings } from '../lib/release-evidence.js';
import { missingRequiredMigrations } from '../lib/migrations.js';

const { Client } = pg;
if (process.env.GO_LIVE !== 'true') throw new Error('GO_LIVE=true is required for the final release audit.');

async function readJsonEnvironmentFile(name) {
  const configured = String(process.env[name] || '').trim();
  if (!configured) throw new Error(`${name} is required.`);
  const filename = path.resolve(configured);
  let raw;
  try { raw = await fs.readFile(filename, 'utf8'); } catch (error) { throw new Error(`Could not read ${name} ${filename}: ${error.message}`); }
  try { return JSON.parse(raw); } catch { throw new Error(`${name} ${filename} is not valid JSON.`); }
}

const [staffRegisterValue, releaseEvidence] = await Promise.all([
  readJsonEnvironmentFile('STAFF_REGISTER_FILE'),
  readJsonEnvironmentFile('RELEASE_EVIDENCE_FILE'),
]);
const staffRegister = parseStaffRegister(staffRegisterValue);
const findings = releaseEvidenceFindings(releaseEvidence, {
  releaseCandidate: process.env.RELEASE_CANDIDATE,
  paymentProvider: process.env.PAYMENT_PROVIDER,
  paymentAdapterId: process.env.PAYMENT_ADAPTER_ID,
  whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  consentVersion: process.env.CONSULTATION_CONSENT_VERSION,
  privacyApprovalId: process.env.PRIVACY_APPROVAL_ID,
  rpoHours: process.env.BACKUP_RPO_HOURS,
  rtoMinutes: process.env.BACKUP_RTO_MINUTES,
});

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) },
});
await client.connect();
try {
  const [migrationResult, staffResult, jobResult, counterResult] = await Promise.all([
    client.query(`SELECT name FROM schema_migrations ORDER BY name`),
    client.query(`
      SELECT id,email,name,role,active,must_rotate_password,mfa_enabled
      FROM staff_users ORDER BY active DESC,lower(email),id
    `),
    client.query(`
      SELECT expected.job_name,
             max(r.completed_at) FILTER (WHERE r.status='SUCCEEDED') last_succeeded_at,
             max(r.completed_at) FILTER (WHERE r.status='FAILED') last_failed_at
      FROM (VALUES ('outbox'),('refills'),('maintenance')) expected(job_name)
      LEFT JOIN operational_job_runs r ON r.job_name=expected.job_name
      GROUP BY expected.job_name ORDER BY expected.job_name
    `),
    client.query(`
      SELECT
        (SELECT count(*)::int FROM message_outbox WHERE status='DEAD') dead_outbox,
        (SELECT count(*)::int FROM message_outbox WHERE status IN ('PENDING','FAILED') AND created_at<now()-interval '15 minutes') delayed_outbox,
        (SELECT count(*)::int FROM whatsapp_messages WHERE direction='OUTBOUND' AND delivery_status IN ('FAILED','NOT_CONFIGURED') AND updated_at<now()-interval '15 minutes') failed_whatsapp,
        (SELECT count(*)::int FROM orders WHERE status='PAYMENT_REVIEW_REQUIRED' AND updated_at<now()-interval '1 hour') payment_review,
        (SELECT count(*)::int FROM payment_events WHERE processing_outcome='REVIEW_REQUIRED' AND reviewed_at IS NULL) payment_event_review,
        (SELECT count(*)::int FROM inventory_stock stock JOIN inventory_items item ON item.id=stock.id
           WHERE item.active=true AND stock.available_quantity<=stock.reorder_level) low_stock,
        (SELECT count(*)::int FROM operational_job_runs WHERE status='RUNNING' AND started_at<now()-interval '15 minutes') stale_running_jobs
    `),
  ]);
  const missingMigrations = missingRequiredMigrations(migrationResult.rows.map((row) => row.name));
  if (missingMigrations.length) findings.push(`The release database is missing migrations: ${missingMigrations.join(', ')}.`);
  findings.push(...staffComplianceFindings(staffResult.rows, { expectedRegister: staffRegister, requireMfa: true }));
  findings.push(...jobFreshnessIssues(jobResult.rows).map((issue) => issue.message));
  findings.push(...backlogIssues(counterResult.rows[0]).map((issue) => `${issue.code}: ${issue.message} Count=${issue.count}.`));
} finally {
  await client.end();
}

if (findings.length) {
  console.error(`Release audit failed with ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Release audit passed for ${releaseEvidence.release_candidate}. All P0/P1 technical checks, dated evidence, and required sign-offs are present.`);
}
