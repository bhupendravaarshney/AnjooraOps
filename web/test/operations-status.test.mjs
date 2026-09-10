import test from 'node:test';
import assert from 'node:assert/strict';
import { backlogIssues, jobFreshnessIssues } from '../lib/operations-status.js';

test('job freshness requires recent outbox and daily job successes', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  const healthy = [
    { job_name: 'outbox', last_succeeded_at: '2026-09-09T11:58:00Z' },
    { job_name: 'refills', last_succeeded_at: '2026-09-09T01:00:00Z' },
    { job_name: 'maintenance', last_succeeded_at: '2026-09-09T00:30:00Z' },
  ];
  assert.deepEqual(jobFreshnessIssues(healthy, now), []);
  const issues = jobFreshnessIssues(healthy.slice(0, 2).map((row) => (
    row.job_name === 'outbox' ? { ...row, last_succeeded_at: '2026-09-09T11:50:00Z' } : row
  )), now);
  assert.ok(issues.some((issue) => issue.code === 'JOB_OVERDUE' && issue.job === 'outbox'));
  assert.ok(issues.some((issue) => issue.code === 'JOB_NEVER_SUCCEEDED' && issue.job === 'maintenance'));
});

test('a failed latest execution stays alerting until a newer success', () => {
  const rows = [
    { job_name: 'outbox', last_succeeded_at: '2026-09-09T11:58:00Z', last_failed_at: '2026-09-09T11:59:00Z' },
    { job_name: 'refills', last_succeeded_at: '2026-09-09T11:00:00Z', last_failed_at: null },
    { job_name: 'maintenance', last_succeeded_at: '2026-09-09T11:00:00Z', last_failed_at: null },
  ];
  const issues = jobFreshnessIssues(rows, new Date('2026-09-09T12:00:00Z'));
  assert.ok(issues.some((issue) => issue.code === 'JOB_LAST_RUN_FAILED' && issue.job === 'outbox'));
});

test('backlog counters become machine-readable alert issues', () => {
  assert.deepEqual(backlogIssues({ dead_outbox: 0, low_stock: 0 }), []);
  assert.deepEqual(backlogIssues({ dead_outbox: 2, low_stock: 1 }).map((issue) => issue.code), ['OUTBOX_DEAD', 'LOW_STOCK']);
});
