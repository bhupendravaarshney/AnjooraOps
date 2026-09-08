import { NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { tokenHash } from '@/lib/security';
import { writeAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rate-limit';
import { HttpError, errorResponse, hashPrivateValue, requestIp, requireSameOrigin } from '@/lib/http';
import { assertTransition } from '@/lib/transitions';

const ACCEPTANCE_TEXT = 'I accept this recommendation and the itemized order total. I understand that payment is a separate step.';
const ACCEPTANCE_VERSION = '2026-09-v1';

function providerPaymentUrl(intent) {
  const base = process.env.PAYMENT_LINK_BASE_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set('reference', intent.public_id);
    url.searchParams.set('amount', String(intent.amount));
    url.searchParams.set('currency', intent.currency);
    return url.toString();
  } catch {
    throw new HttpError(500, 'Payment-link configuration is invalid.', 'PAYMENT_CONFIGURATION_ERROR');
  }
}

export async function POST(request) {
  try {
    requireSameOrigin(request);
    const form = await request.formData();
    const token = String(form.get('token') || '');
    if (!token || token.length > 100 || form.get('accepted') !== 'yes') {
      throw new HttpError(422, 'A valid token and explicit acceptance are required.', 'VALIDATION_ERROR');
    }
    const ip = requestIp(request);
    await enforceRateLimit({ scope: 'order-accept-ip', key: ip, limit: 20, windowSeconds: 900 });
    await enforceRateLimit({ scope: 'order-accept-token', key: tokenHash(token), limit: 8, windowSeconds: 900 });

    await withTransaction(async (db) => {
      const order = (await db.query(`SELECT * FROM orders WHERE acceptance_nonce=$1 FOR UPDATE`, [tokenHash(token)])).rows[0];
      if (!order) throw new HttpError(404, 'Order acceptance link was not found.', 'NOT_FOUND');
      if (order.accepted_at) return;
      if (order.status !== 'AWAITING_ACCEPTANCE') {
        throw new HttpError(409, `Order cannot be accepted from ${order.status}.`, 'INVALID_TRANSITION');
      }
      assertTransition('orders', order.status, 'AWAITING_PAYMENT');
      const evidence = {
        version: ACCEPTANCE_VERSION,
        text: ACCEPTANCE_TEXT,
        ip_hash: hashPrivateValue(ip),
        user_agent_hash: hashPrivateValue(request.headers.get('user-agent') || 'unknown'),
      };
      await db.query(`
        UPDATE orders SET status='AWAITING_PAYMENT',accepted_at=now(),acceptance_channel='WEB',
          acceptance_evidence=$1::jsonb,updated_at=now()
        WHERE id=$2
      `, [JSON.stringify(evidence), order.id]);

      const existing = (await db.query(`SELECT * FROM payment_intents WHERE order_id=$1 AND status='PENDING' FOR UPDATE`, [order.id])).rows[0];
      if (!existing) {
        const intent = {
          id: uuid(), public_id: publicId('ANJ-PAY'), amount: order.amount,
          currency: order.currency, provider: String(process.env.PAYMENT_PROVIDER || 'EXTERNAL').trim().toUpperCase(),
        };
        const paymentUrl = providerPaymentUrl(intent);
        await db.query(`
          INSERT INTO payment_intents(
            id,public_id,order_id,idempotency_key,provider,status,amount,currency,payment_url
          ) VALUES($1,$2,$3,$4,$5,'PENDING',$6,$7,$8)
        `, [intent.id, intent.public_id, order.id, `order:${order.id}:accepted`, intent.provider, intent.amount, intent.currency, paymentUrl]);
      }
      await writeAudit(db, {
        request, entityType: 'ORDER', entityId: order.id, action: 'CUSTOMER_ACCEPTED',
        priorState: order.status, resultingState: 'AWAITING_PAYMENT',
        payload: { acceptance_version: ACCEPTANCE_VERSION, channel: 'WEB' },
      });
    });
    return NextResponse.redirect(new URL(`/accept/order/${encodeURIComponent(token)}?accepted=1`, request.url), 303);
  } catch (error) {
    return errorResponse(error);
  }
}
