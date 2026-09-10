import { query } from '@/lib/db';
import { uuid } from '@/lib/ids';
import { secureEqual } from '@/lib/http';

export const OPERATIONAL_JOBS = Object.freeze(['outbox', 'refills', 'maintenance']);

export function cronAuthorized(request) {
  const supplied = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : '';
  return Boolean(expected && secureEqual(supplied, expected));
}

export async function runOperationalJob(jobName, handler) {
  if (!OPERATIONAL_JOBS.includes(jobName)) throw new Error(`Unsupported operational job: ${jobName}`);
  const id = uuid();
  const started = Date.now();
  await query(`
    INSERT INTO operational_job_runs(id,job_name,status)
    VALUES($1,$2,'RUNNING')
  `, [id, jobName]);
  try {
    const result = await handler();
    await query(`
      UPDATE operational_job_runs
      SET status='SUCCEEDED',result=$1::jsonb,completed_at=now(),duration_ms=$2
      WHERE id=$3
    `, [JSON.stringify(result || {}), Math.max(0, Date.now() - started), id]);
    return result;
  } catch (error) {
    try {
      await query(`
        UPDATE operational_job_runs
        SET status='FAILED',error_code=$1,error_message=$2,completed_at=now(),duration_ms=$3
        WHERE id=$4
      `, [
        String(error?.code || error?.name || 'ERROR').slice(0, 100),
        String(error?.message || error || 'Unknown job error').slice(0, 1000),
        Math.max(0, Date.now() - started), id,
      ]);
    } catch (trackingError) {
      console.error(`Could not record failed ${jobName} run`, trackingError);
    }
    throw error;
  }
}
