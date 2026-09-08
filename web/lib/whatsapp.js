import { query, withTransaction } from '@/lib/db';
import { uuid } from '@/lib/ids';
import { enqueueOutbox } from '@/lib/outbox';
import { writeAudit } from '@/lib/audit';
import { normalizePhone } from '@/lib/phone';
import { HttpError } from '@/lib/http';

export function whatsAppConfigured() {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_GRAPH_VERSION);
}

async function queueMessage({ db, conversationId, to, body, intent, jobType, dedupeKey, templateName = null, parameters = [], onSent = null }) {
  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) throw new HttpError(422, 'WhatsApp destination is invalid.', 'INVALID_PHONE');
  if (!conversationId || !dedupeKey || dedupeKey.length > 300) throw new HttpError(422, 'WhatsApp queue context is invalid.', 'INVALID_MESSAGE_CONTEXT');
  if (String(body || '').length > 4096) throw new HttpError(422, 'WhatsApp message is too long.', 'INVALID_MESSAGE');
  const run = async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [dedupeKey]);
    const existingJob = await client.query(`SELECT payload,status FROM message_outbox WHERE dedupe_key=$1`, [dedupeKey]);
    if (existingJob.rows[0]) {
      return { messageId: existingJob.rows[0].payload?.messageId || null, deliveryStatus: existingJob.rows[0].status, queued: false };
    }
    const messageId = uuid();
    await client.query(`
      INSERT INTO whatsapp_messages(
        id,conversation_id,direction,message_type,body,intent,delivery_status,raw_payload
      ) VALUES($1,$2,'OUTBOUND',$3,$4,$5,'QUEUED','{}'::jsonb)
    `, [messageId, conversationId, jobType === 'WHATSAPP_TEMPLATE' ? 'template' : 'text', body, intent]);
    await enqueueOutbox(client, {
      jobType,
      dedupeKey,
      payload: { messageId, conversationId, to: normalizedTo, body, intent, templateName, parameters, onSent },
    });
    await client.query(`UPDATE whatsapp_conversations SET last_message_at=now(),updated_at=now() WHERE id=$1`, [conversationId]);
    return { messageId, deliveryStatus: 'QUEUED', queued: true };
  };
  return db ? run(db) : withTransaction(run);
}

export function queueWhatsAppText({ db = null, conversationId, to, body, intent = 'SYSTEM', dedupeKey = null, onSent = null }) {
  return queueMessage({
    db,
    conversationId,
    to,
    body,
    intent,
    jobType: 'WHATSAPP_TEXT',
    dedupeKey: dedupeKey || `text:${uuid()}`,
    onSent,
  });
}

export function queueWhatsAppTemplate({ db = null, conversationId, to, templateName, parameters = [], intent = 'SYSTEM_TEMPLATE', dedupeKey = null, onSent = null }) {
  if (!templateName) return Promise.resolve({ deliveryStatus: 'TEMPLATE_NOT_CONFIGURED', queued: false });
  return queueMessage({
    db,
    conversationId,
    to,
    body: `[template:${templateName}] ${parameters.join(' | ')}`,
    intent,
    jobType: 'WHATSAPP_TEMPLATE',
    dedupeKey: dedupeKey || `template:${uuid()}`,
    templateName,
    parameters,
    onSent,
  });
}

export const sendWhatsAppText = queueWhatsAppText;
export const sendWhatsAppTemplate = queueWhatsAppTemplate;

async function applyOnSent(db, action) {
  if (!action) return;
  if (action.type === 'HUMAN_REPLY_SENT') {
    const updated = await db.query(`
      UPDATE whatsapp_conversations
      SET status='HUMAN_SUPPORT',needs_human=false,assigned_to=$1,updated_at=now()
      WHERE id=$2 AND (needs_human=true OR assigned_to IS DISTINCT FROM $1)
      RETURNING id
    `, [action.staffId, action.conversationId]);
    if (updated.rowCount) await writeAudit(db, { staffId: action.staffId, entityType: 'WHATSAPP_CONVERSATION', entityId: action.conversationId, action: 'HUMAN_REPLY_ACCEPTED', resultingState: 'HUMAN_SUPPORT' });
  } else if (action.type === 'CLARIFICATION_SENT') {
    const updated = await db.query(`
      UPDATE review_cases
      SET status='CLARIFICATION_REQUIRED',updated_at=now()
      WHERE id=$1 AND status='CLARIFICATION_PENDING'
      RETURNING id
    `, [action.reviewCaseId]);
    if (updated.rowCount) await writeAudit(db, { entityType: 'REVIEW_CASE', entityId: action.reviewCaseId, action: 'CLARIFICATION_ACCEPTED', priorState: 'CLARIFICATION_PENDING', resultingState: 'CLARIFICATION_REQUIRED' });
  } else if (action.type === 'REFILL_REMINDER_SENT') {
    const updated = await db.query(`
      UPDATE refills
      SET last_reminded_at=now(),last_reminder_type=$1,reminder_event_key=$2,updated_at=now()
      WHERE id=$3 AND reminder_event_key IS DISTINCT FROM $2
      RETURNING id
    `, [action.reminderType, action.eventKey, action.refillId]);
    if (updated.rowCount) await writeAudit(db, { entityType: 'REFILL', entityId: action.refillId, action: 'REMINDER_ACCEPTED', payload: { reminder_type: action.reminderType, event_key: action.eventKey } });
  }
}

export async function deliverWhatsAppJob(job) {
  const payload = job.payload;
  const current = await query(`SELECT delivery_status FROM whatsapp_messages WHERE id=$1`, [payload.messageId]);
  if (!current.rows[0]) throw new Error('Queued WhatsApp message no longer exists.');
  if (['SENT', 'DELIVERED', 'READ'].includes(current.rows[0].delivery_status)) return { alreadySent: true };
  if (!whatsAppConfigured()) {
    await query(`UPDATE whatsapp_messages SET delivery_status='NOT_CONFIGURED',last_error='WhatsApp credentials are not configured',updated_at=now() WHERE id=$1`, [payload.messageId]);
    throw new Error('WhatsApp credentials are not configured.');
  }

  const version = process.env.WHATSAPP_GRAPH_VERSION;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const requestBody = job.job_type === 'WHATSAPP_TEMPLATE'
    ? {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: payload.to,
        type: 'template',
        template: {
          name: payload.templateName,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US' },
          ...(payload.parameters?.length ? {
            components: [{ type: 'body', parameters: payload.parameters.map((text) => ({ type: 'text', text: String(text) })) }],
          } : {}),
        },
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: payload.to,
        type: 'text',
        text: { preview_url: false, body: payload.body },
      };

  let response;
  let raw;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(Number(process.env.WHATSAPP_HTTP_TIMEOUT_MS || 10_000)),
    });
    raw = await response.json().catch(() => ({}));
  } catch (error) {
    await query(`UPDATE whatsapp_messages SET delivery_status='FAILED',last_error=$1,updated_at=now() WHERE id=$2`, [String(error.message).slice(0, 1000), payload.messageId]);
    throw error;
  }
  if (!response.ok) {
    const message = raw?.error?.message || `Meta returned HTTP ${response.status}`;
    await query(`UPDATE whatsapp_messages SET delivery_status='FAILED',raw_payload=$1::jsonb,last_error=$2,updated_at=now() WHERE id=$3`, [JSON.stringify(raw), String(message).slice(0, 1000), payload.messageId]);
    throw new Error(message);
  }

  const metaMessageId = raw?.messages?.[0]?.id || null;
  await withTransaction(async (db) => {
    await db.query(`UPDATE whatsapp_messages SET meta_message_id=$1,delivery_status='SENT',raw_payload=$2::jsonb,last_error=NULL,updated_at=now() WHERE id=$3`, [metaMessageId, JSON.stringify(raw), payload.messageId]);
    await applyOnSent(db, payload.onSent);
  });
  return { metaMessageId, deliveryStatus: 'SENT' };
}
