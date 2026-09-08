import { query } from './db.js';
export function refillReminderDays() {
  const configured = Number(process.env.REFILL_REMINDER_DAYS_BEFORE || 4);
  return Number.isFinite(configured) ? Math.max(0, Math.min(90, Math.trunc(configured))) : 4;
}

export async function refreshRefillStatuses(){
  const reminderDays = refillReminderDays();
  await query(`UPDATE refills SET status='DUE',updated_at=now() WHERE status IN ('NOT_DUE','DUE_SOON') AND due_date<=current_date`);
  await query(`
    UPDATE refills SET status='DUE_SOON',updated_at=now()
    WHERE status='NOT_DUE' AND due_date>current_date
      AND due_date<=current_date+($1 * interval '1 day')
  `, [reminderDays]);
}
