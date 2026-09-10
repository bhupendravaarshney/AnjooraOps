import { spawn } from 'node:child_process';
import './load-env.mjs';
import { assertLocalSchedulerEnvironment, LOCAL_JOB_SCHEDULE } from '../lib/job-schedule.js';

assertLocalSchedulerEnvironment(process.env);

let stopping = false;
const waits = new Map();

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      waits.delete(timeout);
      resolve();
    }, milliseconds);
    waits.set(timeout, resolve);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const [timeout, resolve] of waits) {
    clearTimeout(timeout);
    resolve();
  }
  waits.clear();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

function run(target) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/run-job.mjs', target], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      shell: false,
    });
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once('error', (error) => {
      console.error(`${target} could not start: ${error.message}`);
      finish(1);
    });
    child.once('exit', (code) => finish(code ?? 1));
  });
}

async function runSafely(target) {
  const code = await run(target);
  if (code !== 0) console.error(`${target} scheduler execution exited ${code}; it will retry at the next interval.`);
}

async function loop({ target, intervalMs }) {
  while (!stopping) {
    await wait(intervalMs);
    if (!stopping) await runSafely(target);
  }
}

console.log('Local scheduler starting: outbox every minute; refills and maintenance daily.');
for (const { target } of LOCAL_JOB_SCHEDULE) {
  if (stopping) break;
  await runSafely(target);
}
await Promise.all(LOCAL_JOB_SCHEDULE.map(loop));
console.log('Local scheduler stopped.');
