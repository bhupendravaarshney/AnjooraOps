import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
      'migrations',(SELECT count(*) FROM schema_migrations),
      'customers_table',to_regclass('public.customers') IS NOT NULL,
      'orders_table',to_regclass('public.orders') IS NOT NULL,
      'outbox_table',to_regclass('public.message_outbox') IS NOT NULL,
      'inventory_view',to_regclass('public.inventory_stock') IS NOT NULL
    )::text;`,
  ]).toString('utf8').trim();
  const result = JSON.parse(validation);
  if (Number(result.migrations) < 6 || !result.customers_table || !result.orders_table || !result.outbox_table || !result.inventory_view) {
    throw new Error(`Restored database did not pass structural validation: ${validation}`);
  }
  console.log(`Backup restore drill passed in isolated database ${databaseName}; ${result.migrations} migrations were present.`);
} finally {
  if (created) {
    docker(['exec', '-T', 'postgres', 'dropdb', '-U', 'anjoora', '--force', '--if-exists', databaseName]);
  }
}
