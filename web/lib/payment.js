export const PAYMENT_STATUSES = Object.freeze(['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED']);
const PAYMENT_STATUS_SET = new Set(PAYMENT_STATUSES);
const REQUIRED_EVENT_OUTCOMES = Object.freeze(['PAID', 'FAILED', 'CANCELLED', 'REFUNDED']);

export function parsePaymentEventMap(raw, { requireCoverage = false } = {}) {
  if (!raw) {
    if (requireCoverage) throw new Error('PAYMENT_EVENT_MAP is required for the live payment adapter.');
    return null;
  }
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {
    throw new Error('PAYMENT_EVENT_MAP must be a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error('PAYMENT_EVENT_MAP must be a non-empty JSON object.');
  }
  const result = new Map();
  for (const [providerEvent, canonicalValue] of Object.entries(parsed)) {
    const eventName = String(providerEvent || '').trim();
    const canonicalStatus = String(canonicalValue || '').trim().toUpperCase();
    if (!eventName || eventName.length > 160 || !PAYMENT_STATUS_SET.has(canonicalStatus)) {
      throw new Error(`PAYMENT_EVENT_MAP contains an invalid mapping for ${eventName || '<empty>'}.`);
    }
    result.set(eventName, canonicalStatus);
  }
  if (requireCoverage) {
    const covered = new Set(result.values());
    const missing = REQUIRED_EVENT_OUTCOMES.filter((status) => !covered.has(status));
    if (missing.length) throw new Error(`PAYMENT_EVENT_MAP is missing mappings for ${missing.join(', ')}.`);
  }
  return result;
}

export function canonicalPaymentStatus(payload, eventMap) {
  const eventType = String(payload?.event_type || '').trim();
  if (eventMap) {
    if (!eventType) throw new Error('event_type is required when PAYMENT_EVENT_MAP is configured.');
    const mapped = eventMap.get(eventType);
    if (!mapped) throw new Error(`Unsupported payment event_type: ${eventType}.`);
    return { eventType, status: mapped };
  }
  const status = String(payload?.status || '').trim().toUpperCase();
  if (!PAYMENT_STATUS_SET.has(status)) throw new Error('A supported canonical payment status is required.');
  return { eventType: eventType || status, status };
}

export function paymentEventDecision(orderStatus, paymentStatus) {
  const fulfillmentStates = new Set(['PAID', 'IN_PRODUCTION', 'READY_TO_DISPATCH', 'SHIPPED', 'DELIVERED']);
  if (paymentStatus === 'PAID') {
    if (['AWAITING_PAYMENT', 'PAYMENT_PENDING', 'PAYMENT_REVIEW_REQUIRED'].includes(orderStatus)) {
      return { outcome: 'APPLIED', nextOrderStatus: 'PAID' };
    }
    if (fulfillmentStates.has(orderStatus)) return { outcome: 'IGNORED_STALE', nextOrderStatus: orderStatus };
    return { outcome: 'REVIEW_REQUIRED', nextOrderStatus: orderStatus };
  }
  if (paymentStatus === 'PENDING') {
    if (orderStatus === 'AWAITING_PAYMENT') return { outcome: 'APPLIED', nextOrderStatus: 'PAYMENT_PENDING' };
    if (orderStatus === 'PAYMENT_PENDING') return { outcome: 'APPLIED', nextOrderStatus: orderStatus };
    return { outcome: 'IGNORED_STALE', nextOrderStatus: orderStatus };
  }
  if (paymentStatus === 'FAILED') {
    if (orderStatus === 'PAYMENT_PENDING') return { outcome: 'APPLIED', nextOrderStatus: 'AWAITING_PAYMENT' };
    if (orderStatus === 'AWAITING_PAYMENT') return { outcome: 'APPLIED', nextOrderStatus: orderStatus };
    return { outcome: 'IGNORED_STALE', nextOrderStatus: orderStatus };
  }
  if (paymentStatus === 'CANCELLED') {
    if (['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(orderStatus)) return { outcome: 'APPLIED', nextOrderStatus: 'CANCELLED' };
    if (orderStatus === 'CANCELLED') return { outcome: 'IGNORED_STALE', nextOrderStatus: orderStatus };
    return { outcome: fulfillmentStates.has(orderStatus) ? 'REVIEW_REQUIRED' : 'IGNORED_STALE', nextOrderStatus: orderStatus };
  }
  if (paymentStatus === 'REFUNDED') {
    if (fulfillmentStates.has(orderStatus)) return { outcome: 'APPLIED', nextOrderStatus: 'REFUNDED' };
    if (orderStatus === 'REFUNDED') return { outcome: 'IGNORED_STALE', nextOrderStatus: orderStatus };
    return { outcome: 'REVIEW_REQUIRED', nextOrderStatus: orderStatus };
  }
  throw new Error(`Unsupported payment status: ${paymentStatus}`);
}
