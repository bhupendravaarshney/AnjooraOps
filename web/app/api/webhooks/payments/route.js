import crypto from 'crypto';
import { withTransaction } from '@/lib/db';
import { uuid } from '@/lib/ids';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, hashPrivateValue, secureEqual } from '@/lib/http';
import { assertTransition } from '@/lib/transitions';

const EVENT_STATUSES = new Set(['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED']);

function verifySignature(raw, header) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return secureEqual(expected, header);
}

export async function POST(request) {
  try {
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 65_536) throw new HttpError(413, 'Request body is too large.', 'BODY_TOO_LARGE');
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > 65_536) throw new HttpError(413, 'Request body is too large.', 'BODY_TOO_LARGE');
    if (!verifySignature(raw, request.headers.get('x-payment-signature'))) {
      throw new HttpError(401, 'Invalid payment webhook signature.', 'INVALID_SIGNATURE');
    }
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.', 'INVALID_JSON'); }
    const provider = String(payload.provider || '').trim().toUpperCase().slice(0, 80);
    const eventId = String(payload.event_id || '').trim().slice(0, 200);
    const intentReference = String(payload.intent_reference || '').trim().slice(0, 100);
    const status = String(payload.status || '').trim().toUpperCase();
    if (!provider || !eventId || !intentReference || !EVENT_STATUSES.has(status)) {
      throw new HttpError(422, 'provider, event_id, intent_reference and a valid status are required.', 'VALIDATION_ERROR');
    }

    const result = await withTransaction(async (db) => {
      const inserted = await db.query(`
        INSERT INTO payment_events(id,provider,provider_event_id,event_type,payload)
        VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(provider,provider_event_id) DO NOTHING
        RETURNING id
      `, [uuid(), provider, eventId, status, JSON.stringify(payload)]);
      if (!inserted.rowCount) return { duplicate: true };
      const intent = (await db.query(`
        SELECT * FROM payment_intents
        WHERE public_id=$1 AND provider=$2
        FOR UPDATE
      `, [intentReference, provider])).rows[0];
      if (!intent) throw new HttpError(404, 'Payment intent was not found.', 'NOT_FOUND');
      const order = (await db.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [intent.order_id])).rows[0];
      if (!order) throw new HttpError(404, 'Order was not found.', 'NOT_FOUND');
      if (payload.amount !== undefined && Number(payload.amount).toFixed(2) !== Number(intent.amount).toFixed(2)) {
        throw new HttpError(409, 'Payment amount does not match the intent.', 'PAYMENT_AMOUNT_MISMATCH');
      }
      if (payload.currency && String(payload.currency).toUpperCase() !== intent.currency) {
        throw new HttpError(409, 'Payment currency does not match the intent.', 'PAYMENT_CURRENCY_MISMATCH');
      }
      const providerReference = String(payload.provider_reference || '').trim().slice(0, 200) || intent.provider_reference;
      let nextOrderStatus = order.status;
      let paymentStatus = status;
      if (status === 'PAID') {
        if (order.status !== 'PAID') assertTransition('orders', order.status, 'PAID');
        nextOrderStatus = 'PAID';
      } else if (status === 'PENDING') {
        if (order.status === 'AWAITING_PAYMENT') nextOrderStatus = 'PAYMENT_PENDING';
        else if (order.status !== 'PAYMENT_PENDING') throw new HttpError(409, 'Order cannot enter payment pending.', 'INVALID_TRANSITION');
      } else if (status === 'CANCELLED') {
        if (order.status !== 'CANCELLED') assertTransition('orders', order.status, 'CANCELLED');
        nextOrderStatus = 'CANCELLED';
      } else if (status === 'REFUNDED') {
        if (order.status !== 'REFUNDED') assertTransition('orders', order.status, 'REFUNDED');
        nextOrderStatus = 'REFUNDED';
      } else if (!['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(order.status)) {
        throw new HttpError(409, 'Failed payment cannot update this order state.', 'INVALID_TRANSITION');
      }

      await db.query(`
        UPDATE payment_intents SET status=$1,provider_reference=$2,raw_payload=$3::jsonb,
          paid_at=CASE WHEN $1='PAID' THEN now() ELSE paid_at END,
          failed_at=CASE WHEN $1='FAILED' THEN now() ELSE failed_at END,
          cancelled_at=CASE WHEN $1='CANCELLED' THEN now() ELSE cancelled_at END,
          refunded_at=CASE WHEN $1='REFUNDED' THEN now() ELSE refunded_at END,
          updated_at=now()
        WHERE id=$4
      `, [status, providerReference, JSON.stringify(payload), intent.id]);
      await db.query(`
        UPDATE orders SET status=$1,payment_status=$2,updated_at=now() WHERE id=$3
      `, [nextOrderStatus, paymentStatus, order.id]);
      await db.query(`
        UPDATE payment_events SET payment_intent_id=$1,order_id=$2 WHERE id=$3
      `, [intent.id, order.id, inserted.rows[0].id]);
      await writeAudit(db, {
        request, entityType: 'ORDER', entityId: order.id, action: `PAYMENT_${status}`,
        priorState: order.status, resultingState: nextOrderStatus,
        payload: { payment_intent_id: intent.id, provider, provider_event_hash: hashPrivateValue(eventId) },
      });
      return { duplicate: false, orderStatus: nextOrderStatus };
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
