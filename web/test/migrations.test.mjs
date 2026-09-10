import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_MIGRATIONS, missingRequiredMigrations } from '../lib/migrations.js';

test('release and restore gates require every named migration', () => {
  assert.deepEqual(missingRequiredMigrations(REQUIRED_MIGRATIONS), []);
  assert.deepEqual(
    missingRequiredMigrations(REQUIRED_MIGRATIONS.filter((name) => name !== '008_payment_certification_controls.sql')),
    ['008_payment_certification_controls.sql'],
  );
});
