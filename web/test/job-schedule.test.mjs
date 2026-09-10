import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLocalSchedulerEnvironment,
  LOCAL_JOB_SCHEDULE,
  operationalJobUrl,
} from '../lib/job-schedule.js';

test('local schedule runs outbox each minute and daily jobs every 24 hours', () => {
  assert.deepEqual(LOCAL_JOB_SCHEDULE, [
    { target: 'outbox', intervalMs: 60_000 },
    { target: 'refills', intervalMs: 86_400_000 },
    { target: 'maintenance', intervalMs: 86_400_000 },
  ]);
});

test('operational job URLs require HTTPS outside local targets in production', () => {
  const production = { NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'production' };
  assert.equal(operationalJobUrl('/api/jobs/status', 'https://ops.example.com', production).href, 'https://ops.example.com/api/jobs/status');
  assert.throws(() => operationalJobUrl('/api/jobs/status', 'http://ops.example.com', production), /HTTPS APP_URL/);
  assert.equal(operationalJobUrl('/api/jobs/status', 'http://127.0.0.1:3000', production).port, '3000');
  assert.throws(() => operationalJobUrl('/api/jobs/status', 'file:///tmp/app', production), /HTTP\(S\)/);
});

test('local scheduler is restricted to the local profile and Compose app target', () => {
  const local = {
    NODE_ENV: 'production',
    DEPLOYMENT_PROFILE: 'local',
    GO_LIVE: 'false',
    APP_URL: 'http://app:3000',
    CRON_SECRET: 'test-secret',
  };
  assert.doesNotThrow(() => assertLocalSchedulerEnvironment(local));
  assert.throws(() => assertLocalSchedulerEnvironment({ ...local, GO_LIVE: 'true' }), /local-only/);
  assert.throws(() => assertLocalSchedulerEnvironment({ ...local, DEPLOYMENT_PROFILE: 'production' }), /local-only/);
  assert.throws(() => assertLocalSchedulerEnvironment({ ...local, APP_URL: 'https://ops.example.com' }), /localhost or the local Compose app service/);
  assert.throws(() => assertLocalSchedulerEnvironment({ ...local, CRON_SECRET: '' }), /CRON_SECRET/);
});
