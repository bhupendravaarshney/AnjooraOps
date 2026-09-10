import crypto from 'node:crypto';
import { withTransaction } from '@/lib/db';
import { uuid } from '@/lib/ids';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, hashPrivateValue, secureEqual } from '@/lib/http';
import { assertTransition } from '@/lib/transitions';
import { canonicalPaymentStatus, parsePaymentEventMap, paymentEventDecision } from '@/lib/payment';

function verifySignature(raw, header) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return secureEqual(expected, header);
}

function configuredEvent(payload) {
  let eventMap;
  try { eventMap = parsePaymentEventMap(process.env.PAYMENT_EVENT_MAP); } catch (error) {
    throw new HttpError(500, error.message, 'PAYMENT_CONFIGURATION_ERROR');
  }
  try { return canonicalPaymentStatus(payload, eventMap); } catch (error) {
    throw new HttpError(422, error.message, 'UNSUPPORTED_PAYMENT_EVENT');
  }
}

function paymentAmount(payload, { required }) {
  if (payload.amount === undefined || payload.amount === null || payload.amount === '') {
    if (required) throw new HttpError(422, 'Paid and refunded events must include amount.', 'PAYMENT_AMOUNT_REQUIRED');
    return null;
  }
  const raw = String(payload.amount).trim();
  const amount = Number(raw);
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(raw) || !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
    throw new HttpError(422, 'Payment amount must be a positive value with no more than two decimal places.', 'PAYMENT_AMOUNT_INVALID');
  }
  return amount;
}

function boundedField(payload, name, maximum) {
  const value = String(payload?.[name] ?? '').trim();
  if (value.length > maximum) throw new HttpError(422, `${name} is too long.`, 'VALIDATION_ERROR');
  return value;
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
    const configuredProvider = String(process.env.PAYMENT_PROVIDER || '').trim().toUpperCase();
    const provider = boundedField(payload, 'provider', 80).toUpperCase();
    const eventId = boundedField(payload, 'event_id', 200);
    const intentReference = boundedField(payload, 'intent_reference', 100);
    if (!provider || !eventId || !intentReference) {
      throw new HttpError(422, 'provider, event_id, and intent_reference are required.', 'VALIDATION_ERROR');
    }
    if (!configuredProvider || configuredProvider === 'MANUAL' || provider !== configuredProvider) {
      throw new HttpError(422, 'Payment event provider does not match the configured provider.', 'PAYMENT_PROVIDER_MISMATCH');
    }
    const { eventType, status } = configuredEvent(payload);
    const requiresFinancialEvidence = ['PAID', 'REFUNDED'].includes(status);
    const amount = paymentAmount(payload, { required: requiresFinancialEvidence });
    const currency = boundedField(payload, 'currency', 10).toUpperCase() || null;
    const suppliedProviderReference = boundedField(payload, 'provider_reference', 200) || null;
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      throw new HttpError(422, 'currency must be a three-letter ISO code.', 'PAYMENT_CURRENCY_INVALID');
    }
    if (requiresFinancialEvidence && (!currency || !suppliedProviderReference)) {
      throw new HttpError(422, 'Paid and refunded events must include amount, currency, and provider_reference.', 'PAYMENT_EVIDENCE_REQUIRED');
    }

    const result = await withTransaction(async (db) => {
      const inserted = await db.query(`
        INSERT INTO payment_events(
          id,provider,provider_event_id,event_type,canonical_status,payload,processing_outcome
        ) VALUES($1,$2,$3,$4,$5,$6::jsonb,'APPLIED')
        ON CONFLICT(provider,provider_event_id) DO NOTHING
        RETURNING id
      `, [uuid(), provider, eventId, eventType, status, JSON.stringify(payload)]);
      if (!inserted.rowCount) return { duplicate: true, outcome: 'DUPLICATE' };
      const eventRowId = inserted.rows[0].id;
      const intent = (await db.query(`
        SELECT * FROM payment_intents
        WHERE public_id=$1 AND provider=$2
        FOR UPDATE
      `, [intentReference, provider])).rows[0];
      if (!intent) throw new HttpError(404, 'Payment intent was not found.', 'NOT_FOUND');
      const order = (await db.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [intent.order_id])).rows[0];
      if (!order) throw new HttpError(404, 'Order was not found.', 'NOT_FOUND');

      const comparableFinancialEvent = ['PENDING', 'PAID', 'REFUNDED'].includes(status);
      const amountMismatch = amount !== null && comparableFinancialEvent
        && amount.toFixed(2) !== Number(intent.amount).toFixed(2);
      const currencyMismatch = Boolean(currency && comparableFinancialEvent && currency !== intent.currency);
      const referenceConflict = suppliedProviderReference ? Boolean((await db.query(`
        SELECT 1 FROM payment_intents
        WHERE provider=$1 AND provider_reference=$2 AND id<>$3
        LIMIT 1
      `, [provider, suppliedProviderReference, intent.id])).rowCount) : false;
      const referenceMismatch = Boolean(
        requiresFinancialEvidence && (
          referenceConflict
          || (intent.provider_reference && suppliedProviderReference !== intent.provider_reference)
        ),
      );
      let decision = paymentEventDecision(order.status, status);
      if (amountMismatch || currencyMismatch || referenceMismatch) decision = { outcome: 'REVIEW_REQUIRED', nextOrderStatus: order.status };

      await db.query(`
        UPDATE payment_events
        SET payment_intent_id=$1,order_id=$2,processing_outcome=$3
        WHERE id=$4
      `, [intent.id, order.id, decision.outcome, eventRowId]);

      if (decision.outcome === 'IGNORED_STALE') {
        await writeAudit(db, {
          request, entityType: 'ORDER', entityId: order.id, action: 'PAYMENT_EVENT_IGNORED_STALE',
          priorState: order.status, resultingState: order.status,
          payload: { provider, canonical_status: status, provider_event_hash: hashPrivateValue(eventId) },
        });
        return { duplicate: false, outcome: decision.outcome, orderStatus: order.status };
      }

      if (decision.outcome === 'REVIEW_REQUIRED') {
        const canMoveToReview = ['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(order.status);
        if (canMoveToReview) {
          assertTransition('orders', order.status, 'PAYMENT_REVIEW_REQUIRED');
          await db.query(`
            UPDATE orders SET status='PAYMENT_REVIEW_REQUIRED',payment_status='REVIEW_REQUIRED',updated_at=now()
            WHERE id=$1
          `, [order.id]);
        }
        await db.query(`
          UPDATE payment_intents SET status='REVIEW_REQUIRED',raw_payload=$1::jsonb,updated_at=now()
          WHERE id=$2
        `, [JSON.stringify(payload), intent.id]);
        await writeAudit(db, {
          request, entityType: 'ORDER', entityId: order.id, action: 'PAYMENT_REVIEW_REQUIRED',
          priorState: order.status, resultingState: canMoveToReview ? 'PAYMENT_REVIEW_REQUIRED' : order.status,
          outcome: 'REJECTED',
          payload: {
            provider, canonical_status: status, amount_mismatch: amountMismatch,
            currency_mismatch: currencyMismatch, reference_mismatch: referenceMismatch,
            reference_conflict: referenceConflict,
            provider_event_hash: hashPrivateValue(eventId),
          },
        });
        return {
          duplicate: false, outcome: decision.outcome,
          orderStatus: canMoveToReview ? 'PAYMENT_REVIEW_REQUIRED' : order.status,
        };
      }

      if (decision.nextOrderStatus !== order.status) assertTransition('orders', order.status, decision.nextOrderStatus);
      const providerReference = intent.provider_reference || (requiresFinancialEvidence ? suppliedProviderReference : null);
      await db.query(`
        UPDATE payment_intents SET status=$1,provider_reference=$2,raw_payload=$3::jsonb,
          paid_at=CASE WHEN $1='PAID' THEN now() ELSE paid_at END,
          failed_at=CASE WHEN $1='FAILED' THEN now() ELSE failed_at END,
          cancelled_at=CASE WHEN $1='CANCELLED' THEN now() ELSE cancelled_at END,
          refunded_at=CASE WHEN $1='REFUNDED' THEN now() ELSE refunded_at END,
          updated_at=now()
        WHERE id=$4
      `, [status, providerReference, JSON.stringify(payload), intent.id]);
      await db.query(`UPDATE orders SET status=$1,payment_status=$2,updated_at=now() WHERE id=$3`, [decision.nextOrderStatus, status, order.id]);
      await writeAudit(db, {
        request, entityType: 'ORDER', entityId: order.id, action: `PAYMENT_${status}`,
        priorState: order.status, resultingState: decision.nextOrderStatus,
        payload: { payment_intent_id: intent.id, provider, provider_event_hash: hashPrivateValue(eventId) },
      });
      return { duplicate: false, outcome: decision.outcome, orderStatus: decision.nextOrderStatus };
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
