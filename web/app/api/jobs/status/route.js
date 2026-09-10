import { query } from '@/lib/db';
import { cronAuthorized } from '@/lib/jobs';
import { backlogIssues, jobFreshnessIssues } from '@/lib/operations-status';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  if (!cronAuthorized(request)) return new Response('Unauthorized', { status: 401 });
  try {
    const [jobs, counters] = await Promise.all([
      query(`
        SELECT expected.job_name,
               max(r.completed_at) FILTER (WHERE r.status='SUCCEEDED') last_succeeded_at,
               max(r.completed_at) FILTER (WHERE r.status='FAILED') last_failed_at,
               max(r.started_at) last_started_at
        FROM (VALUES ('outbox'),('refills'),('maintenance')) expected(job_name)
        LEFT JOIN operational_job_runs r ON r.job_name=expected.job_name
        GROUP BY expected.job_name
        ORDER BY expected.job_name
      `),
      query(`
        SELECT
          (SELECT count(*)::int FROM message_outbox WHERE status='DEAD') dead_outbox,
          (SELECT count(*)::int FROM message_outbox
             WHERE status IN ('PENDING','FAILED') AND created_at<now()-interval '15 minutes') delayed_outbox,
          (SELECT count(*)::int FROM whatsapp_messages
             WHERE direction='OUTBOUND' AND delivery_status IN ('FAILED','NOT_CONFIGURED')
               AND updated_at<now()-interval '15 minutes') failed_whatsapp,
          (SELECT count(*)::int FROM orders
             WHERE status='PAYMENT_REVIEW_REQUIRED' AND updated_at<now()-interval '1 hour') payment_review,
          (SELECT count(*)::int FROM payment_events
             WHERE processing_outcome='REVIEW_REQUIRED' AND reviewed_at IS NULL) payment_event_review,
          (SELECT count(*)::int FROM inventory_stock stock
             JOIN inventory_items item ON item.id=stock.id
             WHERE item.active=true AND stock.available_quantity<=stock.reorder_level) low_stock,
          (SELECT count(*)::int FROM operational_job_runs
             WHERE status='RUNNING' AND started_at<now()-interval '15 minutes') stale_running_jobs
      `),
    ]);
    const counts = counters.rows[0];
    const issues = [...jobFreshnessIssues(jobs.rows), ...backlogIssues(counts)];
    return Response.json({
      ok: issues.length === 0,
      checked_at: new Date().toISOString(),
      jobs: jobs.rows,
      counts,
      issues,
      external_checks: ['managed database backup freshness/failure', 'database disk and connection saturation'],
    }, {
      status: issues.length ? 503 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Operational status check failed', error);
    return Response.json({ ok: false, error: 'Operational status could not be checked.' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
