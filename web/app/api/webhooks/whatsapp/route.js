import { withTransaction } from '@/lib/db';
import { uuid, publicId, withPublicIdRetry } from '@/lib/ids';
import { normalizePhone } from '@/lib/phone';
import { verifyMetaSignature } from '@/lib/security';
import { ensureConversation } from '@/lib/bot';
import { enqueueOutbox } from '@/lib/outbox';

export async function GET(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge || '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

function inboundBody(message) {
  return message?.text?.body
    || message?.button?.text
    || message?.interactive?.button_reply?.title
    || message?.interactive?.list_reply?.title
    || '';
}

async function storeInbound(value, message) {
  if (!message?.id) return { stored: false, invalid: true };
  const phone = normalizePhone(message.from);
  if (!phone) return { stored: false, invalid: true };
  const body = inboundBody(message);
  const contactName = String(value?.contacts?.[0]?.profile?.name || 'WhatsApp Customer').trim().slice(0, 100);

  return withPublicIdRetry(() => withTransaction(async (db) => {
    const customerInsert = await db.query(`
      INSERT INTO customers(id,public_id,name,phone,status)
      VALUES($1,$2,$3,$4,'LEAD')
      ON CONFLICT(phone) DO NOTHING
      RETURNING *
    `, [uuid(), publicId('ANJ-C'), contactName, phone]);
    const customer = customerInsert.rows[0]
      || (await db.query(`SELECT * FROM customers WHERE phone=$1 LIMIT 1`, [phone])).rows[0];
    const conversation = await ensureConversation(customer.id, null, db);
    const messageId = uuid();
    const inserted = await db.query(`
      INSERT INTO whatsapp_messages(
        id,conversation_id,meta_message_id,direction,message_type,body,
        delivery_status,raw_payload,processing_status
      ) VALUES($1,$2,$3,'INBOUND',$4,$5,'RECEIVED',$6::jsonb,'QUEUED')
      ON CONFLICT(meta_message_id) DO NOTHING
      RETURNING id
    `, [messageId, conversation.id, message.id, message.type || 'text', body, JSON.stringify(message)]);
    if (!inserted.rowCount) return { stored: false, duplicate: true };

    await db.query(`UPDATE whatsapp_conversations SET last_message_at=now(),updated_at=now() WHERE id=$1`, [conversation.id]);
    await enqueueOutbox(db, {
      jobType: 'BOT_INBOUND',
      dedupeKey: `inbound:${message.id}`,
      payload: { messageId, customerId: customer.id, conversationId: conversation.id, text: body },
    });
    return { stored: true, messageId };
  }));
}

async function storeStatuses(value) {
  let updated = 0;
  for (const statusEvent of value?.statuses || []) {
    if (!statusEvent?.id || !statusEvent?.status) continue;
    const status = String(statusEvent.status).toUpperCase();
    if (!['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(status)) continue;
    const errorMessage = statusEvent?.errors?.[0]?.title || statusEvent?.errors?.[0]?.message || null;
    updated += await withTransaction(async (db) => {
      const result = await db.query(`
        UPDATE whatsapp_messages
        SET delivery_status=CASE
              WHEN delivery_status='READ' THEN 'READ'
              WHEN delivery_status='DELIVERED' AND $1 IN ('SENT','FAILED') THEN 'DELIVERED'
              WHEN delivery_status='FAILED' AND $1='SENT' THEN 'FAILED'
              ELSE $1
            END,
            raw_payload=raw_payload || $2::jsonb,
            last_error=CASE WHEN $1='FAILED' THEN COALESCE($3,last_error) ELSE last_error END,
            updated_at=now()
        WHERE meta_message_id=$4
        RETURNING id,delivery_status
      `, [status, JSON.stringify({ latest_status: statusEvent }), errorMessage, statusEvent.id]);
      const message = result.rows[0];
      if (message?.delivery_status === 'FAILED') {
        await db.query(`
          UPDATE message_outbox
          SET status=CASE WHEN attempts>=max_attempts THEN 'DEAD' ELSE 'FAILED' END,
              next_attempt_at=now(),locked_at=NULL,
              processed_at=CASE WHEN attempts>=max_attempts THEN now() ELSE NULL END,
              last_error=$1,updated_at=now()
          WHERE payload->>'messageId'=$2 AND status='SENT'
        `, [String(errorMessage || 'Meta reported delivery failure').slice(0, 1000), message.id]);
      }
      return result.rowCount;
    });
  }
  return updated;
}

export async function POST(request) {
  if (Number(request.headers.get('content-length') || 0) > 1_048_576) return new Response('Payload too large', { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > 1_048_576) return new Response('Payload too large', { status: 413 });
  if (!verifyMetaSignature(raw, request.headers.get('x-hub-signature-256'))) {
    return new Response('Invalid signature', { status: 401 });
  }
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const values = payload?.entry?.flatMap((entry) => entry.changes || []).map((change) => change.value).filter(Boolean) || [];
  let stored = 0;
  let duplicates = 0;
  let invalid = 0;
  let statuses = 0;

  for (const value of values) {
    statuses += await storeStatuses(value);
    for (const message of value?.messages || []) {
      const result = await storeInbound(value, message);
      if (result.stored) stored += 1;
      else if (result.duplicate) duplicates += 1;
      else invalid += 1;
    }
  }
  return Response.json({ received: true, stored, duplicates, invalid, statuses });
}
