import './load-env.mjs';
import { operationalJobUrl } from '../lib/job-schedule.js';

const target = String(process.argv[2] || '').trim().toLowerCase();
const paths = {
  outbox: '/api/jobs/outbox?limit=100',
  refills: '/api/jobs/refills',
  maintenance: '/api/jobs/maintenance',
  status: '/api/jobs/status',
};
if (!paths[target]) throw new Error(`Job target must be one of ${Object.keys(paths).join(', ')}.`);
if (!process.env.CRON_SECRET) throw new Error('CRON_SECRET is required.');
const configuredUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
if (!configuredUrl) throw new Error('APP_URL is required.');
const url = operationalJobUrl(paths[target], configuredUrl, process.env);

const response = await fetch(url, {
  method: target === 'status' ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  signal: AbortSignal.timeout(60_000),
});
const body = await response.text();
if (!response.ok) {
  console.error(`${target} returned HTTP ${response.status}: ${body.slice(0, 1000)}`);
  process.exitCode = 1;
} else {
  console.log(`${target} completed: ${body}`);
}
