import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPaymentStatus, parsePaymentEventMap, paymentEventDecision } from '../lib/payment.js';

const eventMap = parsePaymentEventMap(JSON.stringify({
  'payment.pending': 'PENDING',
  'payment.captured': 'PAID',
  'payment.failed': 'FAILED',
  'payment.cancelled': 'CANCELLED',
  'refund.processed': 'REFUNDED',
}), { requireCoverage: true });

test('maps actual provider event names to canonical payment states', () => {
  assert.deepEqual(canonicalPaymentStatus({ event_type: 'payment.captured' }, eventMap), {
    eventType: 'payment.captured', status: 'PAID',
  });
  assert.throws(() => canonicalPaymentStatus({ event_type: 'unknown.event' }, eventMap), /Unsupported payment event_type/);
  assert.throws(() => parsePaymentEventMap('{bad-json'), /JSON object/);
  assert.throws(() => parsePaymentEventMap('{"paid":"PAID"}', { requireCoverage: true }), /missing mappings/);
});

test('delayed payment events never downgrade a paid or fulfilled order', () => {
  assert.deepEqual(paymentEventDecision('PAID', 'FAILED'), { outcome: 'IGNORED_STALE', nextOrderStatus: 'PAID' });
  assert.deepEqual(paymentEventDecision('SHIPPED', 'PENDING'), { outcome: 'IGNORED_STALE', nextOrderStatus: 'SHIPPED' });
  assert.deepEqual(paymentEventDecision('PAID', 'CANCELLED'), { outcome: 'REVIEW_REQUIRED', nextOrderStatus: 'PAID' });
  assert.deepEqual(paymentEventDecision('DELIVERED', 'REFUNDED'), { outcome: 'APPLIED', nextOrderStatus: 'REFUNDED' });
});

test('failed and successful payment decisions preserve the fulfilment gate', () => {
  assert.deepEqual(paymentEventDecision('PAYMENT_PENDING', 'FAILED'), { outcome: 'APPLIED', nextOrderStatus: 'AWAITING_PAYMENT' });
  assert.deepEqual(paymentEventDecision('AWAITING_PAYMENT', 'PAID'), { outcome: 'APPLIED', nextOrderStatus: 'PAID' });
  assert.deepEqual(paymentEventDecision('PAYMENT_PENDING', 'CANCELLED'), { outcome: 'APPLIED', nextOrderStatus: 'CANCELLED' });
  assert.deepEqual(paymentEventDecision('IN_PRODUCTION', 'REFUNDED'), { outcome: 'APPLIED', nextOrderStatus: 'REFUNDED' });
});
