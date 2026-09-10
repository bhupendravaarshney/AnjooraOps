import { withTransaction } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { cronAuthorized, runOperationalJob } from '@/lib/jobs';

function days(name, fallback, minimum = 1, maximum = 3650) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.trunc(value))) : fallback;
}

export async function POST(request) {
  if (!cronAuthorized(request)) return new Response('Unauthorized', { status: 401 });
  const settings = {
    consultationRawDays: days('CONSULTATION_RAW_PAYLOAD_DAYS', 30),
    whatsappRawDays: days('WHATSAPP_RAW_PAYLOAD_DAYS', 30),
    whatsappBodyDays: days('WHATSAPP_MESSAGE_BODY_DAYS', 365, 30),
    paymentRawDays: days('PAYMENT_RAW_PAYLOAD_DAYS', 30),
    rateLimitDays: days('RATE_LIMIT_EVENT_DAYS', 2),
    outboxDays: days('OUTBOX_RETENTION_DAYS', 365, 30),
    jobRunDays: days('JOB_RUN_RETENTION_DAYS', 90, 7),
    auditDays: days('AUDIT_RETENTION_DAYS', 2555, 365),
    customerRecordDays: days('CUSTOMER_RECORD_RETENTION_DAYS', 2555, 365),
  };
  try {
    const result = await runOperationalJob('maintenance', () => withTransaction(async (db) => {
    const sessions = await db.query(`DELETE FROM sessions WHERE expires_at<=now()`);
    const limits = await db.query(`DELETE FROM rate_limit_events WHERE created_at<now()-($1 * interval '1 day')`, [settings.rateLimitDays]);
    const consultations = await db.query(`
      UPDATE consultations c SET raw_payload='{}'::jsonb,raw_payload_purged_at=now()
      FROM customers cu WHERE cu.id=c.customer_id AND cu.legal_hold=false
        AND c.raw_payload_purged_at IS NULL AND c.created_at<now()-($1 * interval '1 day')
    `, [settings.consultationRawDays]);
    const messages = await db.query(`
      UPDATE whatsapp_messages m SET raw_payload='{}'::jsonb,raw_payload_purged_at=now(),updated_at=now()
      FROM whatsapp_conversations wc,customers cu
      WHERE wc.id=m.conversation_id AND cu.id=wc.customer_id AND cu.legal_hold=false
        AND m.raw_payload_purged_at IS NULL AND m.created_at<now()-($1 * interval '1 day')
    `, [settings.whatsappRawDays]);
    const messageBodies = await db.query(`
      UPDATE whatsapp_messages m SET body=NULL,updated_at=now()
      FROM whatsapp_conversations wc,customers cu
      WHERE wc.id=m.conversation_id AND cu.id=wc.customer_id AND cu.legal_hold=false
        AND m.body IS NOT NULL AND m.created_at<now()-($1 * interval '1 day')
    `, [settings.whatsappBodyDays]);
    const payments = await db.query(`
      UPDATE payment_events pe SET payload='{}'::jsonb,raw_payload_purged_at=now()
      FROM orders o,customers cu
      WHERE o.id=pe.order_id AND cu.id=o.customer_id AND cu.legal_hold=false
        AND pe.raw_payload_purged_at IS NULL AND pe.processed_at<now()-($1 * interval '1 day')
    `, [settings.paymentRawDays]);
    const paymentIntents = await db.query(`
      UPDATE payment_intents pi SET raw_payload='{}'::jsonb,updated_at=now()
      FROM orders o,customers cu
      WHERE o.id=pi.order_id AND cu.id=o.customer_id AND cu.legal_hold=false
        AND pi.raw_payload<>'{}'::jsonb AND pi.updated_at<now()-($1 * interval '1 day')
    `, [settings.paymentRawDays]);
    const outbox = await db.query(`
      DELETE FROM message_outbox
      WHERE status IN ('SENT','DEAD') AND updated_at<now()-($1 * interval '1 day')
    `, [settings.outboxDays]);
    const jobRuns = await db.query(`
      DELETE FROM operational_job_runs
      WHERE status IN ('SUCCEEDED','FAILED')
        AND completed_at<now()-($1 * interval '1 day')
    `, [settings.jobRunDays]);
    const audits = await db.query(`
      WITH held_entities AS (
        SELECT id FROM customers WHERE legal_hold=true
        UNION SELECT c.id FROM consultations c JOIN customers cu ON cu.id=c.customer_id WHERE cu.legal_hold=true
        UNION SELECT rc.id FROM review_cases rc JOIN consultations c ON c.id=rc.consultation_id JOIN customers cu ON cu.id=c.customer_id WHERE cu.legal_hold=true
        UNION SELECT r.id FROM recommendations r JOIN consultations c ON c.id=r.consultation_id JOIN customers cu ON cu.id=c.customer_id WHERE cu.legal_hold=true
        UNION SELECT f.id FROM formulas f JOIN customers cu ON cu.id=f.customer_id WHERE cu.legal_hold=true
        UNION SELECT o.id FROM orders o JOIN customers cu ON cu.id=o.customer_id WHERE cu.legal_hold=true
        UNION SELECT b.id FROM batches b JOIN orders o ON o.id=b.order_id JOIN customers cu ON cu.id=o.customer_id WHERE cu.legal_hold=true
        UNION SELECT d.id FROM dispatches d JOIN orders o ON o.id=d.order_id JOIN customers cu ON cu.id=o.customer_id WHERE cu.legal_hold=true
        UNION SELECT r.id FROM refills r JOIN customers cu ON cu.id=r.customer_id WHERE cu.legal_hold=true
        UNION SELECT wc.id FROM whatsapp_conversations wc JOIN customers cu ON cu.id=wc.customer_id WHERE cu.legal_hold=true
        UNION SELECT m.id FROM whatsapp_messages m JOIN whatsapp_conversations wc ON wc.id=m.conversation_id JOIN customers cu ON cu.id=wc.customer_id WHERE cu.legal_hold=true
        UNION SELECT dsr.id FROM data_subject_requests dsr JOIN customers cu ON cu.id=dsr.customer_id WHERE cu.legal_hold=true
      )
      DELETE FROM audit_events a
      WHERE a.created_at<now()-($1 * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM held_entities held WHERE held.id=a.entity_id)
    `, [settings.auditDays]);
    const lifecycleReview = await db.query(`
      SELECT count(DISTINCT cu.id)::int count
      FROM customers cu JOIN consultations c ON c.customer_id=cu.id
      WHERE cu.legal_hold=false AND cu.status<>'ANONYMIZED'
        AND c.created_at<now()-($1 * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id=cu.id AND o.status NOT IN ('DELIVERED','CANCELLED','REFUNDED'))
        AND NOT EXISTS (SELECT 1 FROM refills r WHERE r.customer_id=cu.id AND r.status NOT IN ('ORDERED','CLOSED'))
    `, [settings.customerRecordDays]);
    const counts = {
      sessions: sessions.rowCount, rate_limit_events: limits.rowCount,
      consultation_payloads: consultations.rowCount, message_payloads: messages.rowCount,
      message_bodies: messageBodies.rowCount,
      payment_payloads: payments.rowCount, payment_intent_payloads: paymentIntents.rowCount,
      outbox_jobs: outbox.rowCount, operational_job_runs: jobRuns.rowCount,
      audit_events: audits.rowCount,
      customer_records_due_for_review: lifecycleReview.rows[0].count,
    };
    await writeAudit(db, { request, entityType: 'SYSTEM', action: 'MAINTENANCE_COMPLETED', payload: { counts, settings } });
    return counts;
    }));
    return Response.json({ ok: true, purged: result });
  } catch (error) {
    console.error('Maintenance job failed', error);
    return Response.json({ ok: false, error: 'Maintenance job failed.' }, { status: 500 });
  }
}
