export const JOB_MAX_AGE_SECONDS = Object.freeze({
  outbox: 5 * 60,
  refills: 26 * 60 * 60,
  maintenance: 26 * 60 * 60,
});

export function jobFreshnessIssues(rows, now = new Date()) {
  const byName = new Map((rows || []).map((row) => [row.job_name, row]));
  const issues = [];
  for (const [jobName, maximumAgeSeconds] of Object.entries(JOB_MAX_AGE_SECONDS)) {
    const row = byName.get(jobName);
    const lastSucceededAt = row?.last_succeeded_at ? new Date(row.last_succeeded_at).getTime() : null;
    const lastFailedAt = row?.last_failed_at ? new Date(row.last_failed_at).getTime() : null;
    if (Number.isFinite(lastFailedAt) && (!Number.isFinite(lastSucceededAt) || lastFailedAt > lastSucceededAt)) {
      issues.push({ code: 'JOB_LAST_RUN_FAILED', job: jobName, message: `${jobName} has failed since its last successful run.` });
    }
    if (!row?.last_succeeded_at) {
      issues.push({ code: 'JOB_NEVER_SUCCEEDED', job: jobName, message: `${jobName} has no successful recorded run.` });
      continue;
    }
    const ageSeconds = Math.max(0, (now.getTime() - lastSucceededAt) / 1000);
    if (!Number.isFinite(ageSeconds) || ageSeconds > maximumAgeSeconds) {
      issues.push({
        code: 'JOB_OVERDUE', job: jobName,
        message: `${jobName} last succeeded ${Math.round(ageSeconds)} seconds ago; maximum is ${maximumAgeSeconds}.`,
      });
    }
  }
  return issues;
}

export function backlogIssues(counts) {
  const definitions = [
    ['dead_outbox', 'OUTBOX_DEAD', 'Dead outbox jobs require intervention.'],
    ['delayed_outbox', 'OUTBOX_DELAYED', 'Outbox work has been delayed for more than 15 minutes.'],
    ['failed_whatsapp', 'WHATSAPP_FAILED', 'WhatsApp callbacks or sends have remained failed for more than 15 minutes.'],
    ['payment_review', 'PAYMENT_REVIEW_OVERDUE', 'Payment review work has exceeded one hour.'],
    ['payment_event_review', 'PAYMENT_EVENT_REVIEW', 'A provider event requires manual review.'],
    ['low_stock', 'LOW_STOCK', 'Inventory is at or below reorder level.'],
    ['stale_running_jobs', 'JOB_STALLED', 'An operational job has remained RUNNING for more than 15 minutes.'],
  ];
  return definitions
    .filter(([key]) => Number(counts?.[key] || 0) > 0)
    .map(([key, code, message]) => ({ code, count: Number(counts[key]), message }));
}
