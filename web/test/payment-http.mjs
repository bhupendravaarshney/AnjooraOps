import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import '../scripts/load-env.mjs';

const { Client } = pg;
const baseUrl = new URL(process.env.PAYMENT_SMOKE_URL || 'http://127.0.0.1:3002');
if (!['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname) && process.env.ALLOW_REMOTE_HTTP_SMOKE !== 'true') {
  throw new Error('PAYMENT_SMOKE_URL must be local unless ALLOW_REMOTE_HTTP_SMOKE=true is set for isolated staging.');
}
const provider = String(process.env.PAYMENT_PROVIDER || '').trim().toUpperCase();
const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!provider || provider === 'MANUAL' || !webhookSecret) throw new Error('A non-manual PAYMENT_PROVIDER and PAYMENT_WEBHOOK_SECRET are required.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const databaseUrl = new URL(process.env.DATABASE_URL);
if (databaseUrl.hostname === 'postgres') databaseUrl.hostname = '127.0.0.1';
const databaseSsl = process.env.DATABASE_SSL === 'true'
  ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) }
  : undefined;
const client = new Client({ connectionString: databaseUrl.toString(), ssl: databaseSsl });
const marker = crypto.randomBytes(8).toString('hex');
const id = () => crypto.randomUUID();
const publicId = (prefix) => `${prefix}-PAYSMOKE-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
const customerId = id();
const consultationId = id();
const reviewId = id();
const productId = id();
const orderIds = [];

async function postEvent(payload, secret = webhookSecret) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const response = await fetch(new URL('/api/webhooks/payments', baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Payment-Signature': signature },
    body: raw,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  return { response, body };
}

async function createOrder(status, paymentStatus) {
  const recommendationId = id();
  const orderId = id();
  const intentId = id();
  const intentPublicId = publicId('ANJ-PAY');
  await client.query(`
    INSERT INTO recommendations(
      id,public_id,consultation_id,review_case_id,summary,fulfillment_type,
      product_id,status,is_current
    ) VALUES($1,$2,$3,$4,'Payment smoke','STANDARD',$5,'APPROVED',false)
  `, [recommendationId, publicId('ANJ-REC'), consultationId, reviewId, productId]);
  await client.query(`
    INSERT INTO orders(
      id,public_id,customer_id,consultation_id,recommendation_id,status,
      amount,subtotal,payment_status,accepted_at
    ) VALUES($1,$2,$3,$4,$5,$6,100,100,$7,now())
  `, [orderId, publicId('ANJ-ORD'), customerId, consultationId, recommendationId, status, paymentStatus]);
  await client.query(`
    INSERT INTO payment_intents(
      id,public_id,order_id,idempotency_key,provider,status,amount,currency
    ) VALUES($1,$2,$3,$4,$5,$6,100,'INR')
  `, [intentId, intentPublicId, orderId, `payment-smoke:${orderId}`, provider, paymentStatus]);
  orderIds.push(orderId);
  return { orderId, intentPublicId };
}

await client.connect();
try {
  await client.query(`INSERT INTO customers(id,public_id,name,phone) VALUES($1,$2,'Payment Smoke',$3)`, [customerId, publicId('ANJ-C'), `9198${crypto.randomInt(10000000, 99999999)}`]);
  await client.query(`
    INSERT INTO consultations(id,public_id,folio_id,customer_id,concern,folio_text,consent_at,status)
    VALUES($1,$2,$3,$4,'Sleep','payment smoke',now(),'REVIEWED')
  `, [consultationId, publicId('ANJ-CON'), publicId('ANJ-FOL'), customerId]);
  await client.query(`INSERT INTO review_cases(id,public_id,consultation_id,status) VALUES($1,$2,$3,'APPROVED')`, [reviewId, publicId('ANJ-CASE'), consultationId]);
  await client.query(`INSERT INTO products(id,public_id,sku,name,active) VALUES($1,$2,$3,'Payment smoke product',true)`, [productId, publicId('ANJ-PROD'), `PAY-SMOKE-${marker}`]);

  const paid = await createOrder('AWAITING_PAYMENT', 'PENDING');
  const paidPayload = {
    provider, event_id: `evt-paid-${marker}`, event_type: 'payment.captured',
    intent_reference: paid.intentPublicId, amount: 100, currency: 'INR', provider_reference: `pay-${marker}`,
  };
  const invalidSignature = await postEvent(paidPayload, 'incorrect-signature-secret');
  assert.equal(invalidSignature.response.status, 401);
  const paidResult = await postEvent(paidPayload);
  assert.equal(paidResult.response.status, 200, JSON.stringify(paidResult.body));
  assert.equal(paidResult.body.outcome, 'APPLIED');
  const duplicate = await postEvent(paidPayload);
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  const delayed = await postEvent({
    provider, event_id: `evt-delayed-${marker}`, event_type: 'payment.failed', intent_reference: paid.intentPublicId,
  });
  assert.equal(delayed.body.outcome, 'IGNORED_STALE');

  const failed = await createOrder('PAYMENT_PENDING', 'PENDING');
  const failedResult = await postEvent({
    provider, event_id: `evt-failed-${marker}`, event_type: 'payment.failed', intent_reference: failed.intentPublicId,
  });
  assert.equal(failedResult.body.orderStatus, 'AWAITING_PAYMENT');

  const cancelled = await createOrder('PAYMENT_PENDING', 'PENDING');
  const cancelledResult = await postEvent({
    provider, event_id: `evt-cancelled-${marker}`, event_type: 'payment.cancelled', intent_reference: cancelled.intentPublicId,
  });
  assert.equal(cancelledResult.body.orderStatus, 'CANCELLED');

  const refunded = await createOrder('PAID', 'PAID');
  await client.query(`UPDATE payment_intents SET provider_reference=$1 WHERE public_id=$2`, [`pay-refund-${marker}`, refunded.intentPublicId]);
  const refundedResult = await postEvent({
    provider, event_id: `evt-refunded-${marker}`, event_type: 'refund.processed', intent_reference: refunded.intentPublicId,
    amount: 100, currency: 'INR', provider_reference: `pay-refund-${marker}`,
  });
  assert.equal(refundedResult.body.orderStatus, 'REFUNDED');

  const partialRefund = await createOrder('PAID', 'PAID');
  await client.query(`UPDATE payment_intents SET provider_reference=$1 WHERE public_id=$2`, [`pay-partial-${marker}`, partialRefund.intentPublicId]);
  const partialRefundResult = await postEvent({
    provider, event_id: `evt-partial-refund-${marker}`, event_type: 'refund.processed', intent_reference: partialRefund.intentPublicId,
    amount: 25, currency: 'INR', provider_reference: `pay-partial-${marker}`,
  });
  assert.equal(partialRefundResult.body.outcome, 'REVIEW_REQUIRED');
  assert.equal(partialRefundResult.body.orderStatus, 'PAID');

  const mismatch = await createOrder('AWAITING_PAYMENT', 'PENDING');
  const mismatchResult = await postEvent({
    provider, event_id: `evt-mismatch-${marker}`, event_type: 'payment.captured',
    intent_reference: mismatch.intentPublicId, amount: 99, currency: 'INR', provider_reference: `mismatch-${marker}`,
  });
  assert.equal(mismatchResult.body.outcome, 'REVIEW_REQUIRED');
  assert.equal(mismatchResult.body.orderStatus, 'PAYMENT_REVIEW_REQUIRED');

  const referenceMismatch = await createOrder('AWAITING_PAYMENT', 'PENDING');
  await client.query(`UPDATE payment_intents SET provider_reference=$1 WHERE public_id=$2`, [`expected-${marker}`, referenceMismatch.intentPublicId]);
  const referenceMismatchResult = await postEvent({
    provider, event_id: `evt-reference-${marker}`, event_type: 'payment.captured',
    intent_reference: referenceMismatch.intentPublicId, amount: 100, currency: 'INR', provider_reference: `unexpected-${marker}`,
  });
  assert.equal(referenceMismatchResult.body.outcome, 'REVIEW_REQUIRED');
  assert.equal(referenceMismatchResult.body.orderStatus, 'PAYMENT_REVIEW_REQUIRED');

  const invalidPrecision = await createOrder('AWAITING_PAYMENT', 'PENDING');
  const invalidPrecisionResult = await postEvent({
    provider, event_id: `evt-precision-${marker}`, event_type: 'payment.captured',
    intent_reference: invalidPrecision.intentPublicId, amount: 99.999, currency: 'INR', provider_reference: `precision-${marker}`,
  });
  assert.equal(invalidPrecisionResult.response.status, 422);
  assert.equal(invalidPrecisionResult.body.code, 'PAYMENT_AMOUNT_INVALID');

  const states = await client.query(`SELECT id,status,payment_status FROM orders WHERE id=ANY($1::uuid[])`, [orderIds]);
  const byId = new Map(states.rows.map((row) => [row.id, row]));
  assert.deepEqual([byId.get(paid.orderId).status, byId.get(paid.orderId).payment_status], ['PAID', 'PAID']);
  assert.deepEqual([byId.get(failed.orderId).status, byId.get(failed.orderId).payment_status], ['AWAITING_PAYMENT', 'FAILED']);
  assert.deepEqual([byId.get(cancelled.orderId).status, byId.get(cancelled.orderId).payment_status], ['CANCELLED', 'CANCELLED']);
  assert.deepEqual([byId.get(refunded.orderId).status, byId.get(refunded.orderId).payment_status], ['REFUNDED', 'REFUNDED']);
  assert.deepEqual([byId.get(partialRefund.orderId).status, byId.get(partialRefund.orderId).payment_status], ['PAID', 'PAID']);
  assert.deepEqual([byId.get(mismatch.orderId).status, byId.get(mismatch.orderId).payment_status], ['PAYMENT_REVIEW_REQUIRED', 'REVIEW_REQUIRED']);
  assert.deepEqual([byId.get(referenceMismatch.orderId).status, byId.get(referenceMismatch.orderId).payment_status], ['PAYMENT_REVIEW_REQUIRED', 'REVIEW_REQUIRED']);
  assert.deepEqual([byId.get(invalidPrecision.orderId).status, byId.get(invalidPrecision.orderId).payment_status], ['AWAITING_PAYMENT', 'PENDING']);
  console.log('Payment HTTP certification checks passed: signature, success, failure, cancellation, full/partial refund handling, duplicate, delayed event, amount/reference mismatch, and amount precision rejection.');
} finally {
  try {
    if (orderIds.length) {
      await client.query(`DELETE FROM audit_events WHERE entity_id=ANY($1::uuid[])`, [orderIds]);
      await client.query(`DELETE FROM payment_events WHERE order_id=ANY($1::uuid[])`, [orderIds]);
      await client.query(`DELETE FROM payment_intents WHERE order_id=ANY($1::uuid[])`, [orderIds]);
      await client.query(`DELETE FROM orders WHERE id=ANY($1::uuid[])`, [orderIds]);
    }
    await client.query(`DELETE FROM recommendations WHERE consultation_id=$1`, [consultationId]);
    await client.query(`DELETE FROM review_cases WHERE id=$1`, [reviewId]);
    await client.query(`DELETE FROM consultations WHERE id=$1`, [consultationId]);
    await client.query(`DELETE FROM products WHERE id=$1`, [productId]);
    await client.query(`DELETE FROM customers WHERE id=$1`, [customerId]);
  } finally {
    await client.end();
  }
}
