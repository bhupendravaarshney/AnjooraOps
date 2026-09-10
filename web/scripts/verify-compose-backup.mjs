import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import './load-env.mjs';
import { missingRequiredMigrations } from '../lib/migrations.js';

const databaseName = `anjoora_restore_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
if (!/^anjoora_restore_test_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error('Unsafe restore-test database name.');
}

const projectRoot = path.resolve(process.cwd(), '..');
const maximumBuffer = 1024 * 1024 * 1024;
const docker = (args, options = {}) => execFileSync('docker', ['compose', ...args], {
  cwd: projectRoot,
  maxBuffer: maximumBuffer,
  stdio: ['pipe', 'pipe', 'pipe'],
  ...options,
});

let created = false;
try {
  const backupTimestamp = new Date();
  const restoreStartedAt = new Date();
  docker(['exec', '-T', 'postgres', 'pg_isready', '-U', 'anjoora', '-d', 'anjoora']);
  const dump = docker([
    'exec', '-T', 'postgres', 'pg_dump', '-U', 'anjoora', '-d', 'anjoora',
    '--format=custom', '--no-owner', '--no-acl',
  ]);
  if (!dump.length) throw new Error('The backup command returned an empty archive.');

  docker(['exec', '-T', 'postgres', 'createdb', '-U', 'anjoora', databaseName]);
  created = true;
  docker([
    'exec', '-T', 'postgres', 'pg_restore', '-U', 'anjoora', '-d', databaseName,
    '--exit-on-error', '--no-owner', '--no-acl',
  ], { input: dump });

  const validation = docker([
    'exec', '-T', 'postgres', 'psql', '-U', 'anjoora', '-d', databaseName,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT json_build_object(
      'migrations',ARRAY(SELECT name FROM schema_migrations ORDER BY name),
      'customers_table',to_regclass('public.customers') IS NOT NULL,
      'orders_table',to_regclass('public.orders') IS NOT NULL,
      'outbox_table',to_regclass('public.message_outbox') IS NOT NULL,
      'inventory_view',to_regclass('public.inventory_stock') IS NOT NULL
    )::text;`,
  ]).toString('utf8').trim();
  const result = JSON.parse(validation);
  const missingMigrations = missingRequiredMigrations(result.migrations);
  if (missingMigrations.length || !result.customers_table || !result.orders_table || !result.outbox_table || !result.inventory_view) {
    throw new Error(`Restored database did not pass structural validation: ${validation}`);
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to exercise the managed-restore validator.');
  const sourceUrl = new URL(process.env.DATABASE_URL);
  sourceUrl.hostname = '127.0.0.1';
  sourceUrl.port = '5432';
  const restoreUrl = new URL(sourceUrl);
  restoreUrl.pathname = `/${databaseName}`;
  const validatorOutput = execFileSync(process.execPath, ['scripts/validate-restore.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: sourceUrl.toString(),
      RESTORE_CONFIRM_ISOLATED: 'true',
      RESTORE_DATABASE_URL: restoreUrl.toString(),
      RESTORE_DATABASE_SSL: 'false',
      RESTORE_BACKUP_TIMESTAMP: backupTimestamp.toISOString(),
      RESTORE_TARGET_TIMESTAMP: backupTimestamp.toISOString(),
      RESTORE_STARTED_AT: restoreStartedAt.toISOString(),
      RESTORE_OPERATOR: 'Automated local restore test',
      BACKUP_RPO_HOURS: '1',
      BACKUP_RTO_MINUTES: '60',
      RESTORE_REQUIRE_REPRESENTATIVE_DATA: 'false',
      RESTORE_EVIDENCE_FILE: '',
    },
  });
  if (!validatorOutput.includes('"result": "PASSED"')) throw new Error('Managed-restore validator did not report a passing result.');
  console.log(`Backup restore drill and read-only validator passed in isolated database ${databaseName}; all ${result.migrations.length} required migrations were present.`);
} finally {
  if (created) {
    docker(['exec', '-T', 'postgres', 'dropdb', '-U', 'anjoora', '--force', '--if-exists', databaseName]);
  }
}
