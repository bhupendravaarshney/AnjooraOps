import { HttpError } from './http.js';

export const TRANSITIONS = Object.freeze({
  orders: Object.freeze({
    AWAITING_ACCEPTANCE: ['AWAITING_PAYMENT', 'CANCELLED'],
    AWAITING_PAYMENT: ['PAYMENT_PENDING', 'PAID', 'CANCELLED'],
    PAYMENT_PENDING: ['PAID', 'AWAITING_PAYMENT', 'CANCELLED'],
    PAYMENT_REVIEW_REQUIRED: ['PAID', 'CANCELLED'],
    PAID: ['IN_PRODUCTION', 'READY_TO_DISPATCH', 'REFUNDED'],
    IN_PRODUCTION: ['READY_TO_DISPATCH', 'REFUNDED'],
    READY_TO_DISPATCH: ['SHIPPED', 'REFUNDED'],
    SHIPPED: ['DELIVERED', 'REFUNDED'],
    DELIVERED: ['REFUNDED'],
  }),
  batches: Object.freeze({
    PENDING: ['READY_FOR_PACKING'],
  }),
  dispatches: Object.freeze({
    READY_FOR_DISPATCH: ['DISPATCHED'],
    DISPATCHED: ['DELIVERED'],
  }),
  refills: Object.freeze({
    NOT_DUE: ['DUE_SOON', 'DUE', 'REVIEW_PENDING', 'CLOSED'],
    DUE_SOON: ['DUE', 'REVIEW_PENDING', 'ORDERED', 'CLOSED'],
    DUE: ['REVIEW_PENDING', 'ORDERED', 'CLOSED'],
    REVIEW_PENDING: ['ORDERED', 'CLOSED'],
  }),
  review_cases: Object.freeze({
    NEW: ['CLARIFICATION_PENDING', 'ON_HOLD', 'CLOSED', 'READY_FOR_RECOMMENDATION'],
    CLARIFICATION_PENDING: ['CLARIFICATION_REQUIRED', 'NEW', 'ON_HOLD', 'CLOSED'],
    CLARIFICATION_REQUIRED: ['NEW', 'ON_HOLD', 'CLOSED'],
    ON_HOLD: ['NEW', 'CLOSED', 'READY_FOR_RECOMMENDATION'],
    READY_FOR_RECOMMENDATION: ['APPROVED', 'NEW', 'ON_HOLD', 'CLOSED'],
    APPROVED: ['NEW', 'CLOSED'],
  }),
});

const TABLES = new Set(Object.keys(TRANSITIONS));

export async function lockEntity(db, table, id) {
  if (!TABLES.has(table)) throw new Error(`Unsupported workflow table: ${table}`);
  const { rows } = await db.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new HttpError(404, `${table.slice(0, -1)} not found.`, 'NOT_FOUND');
  return rows[0];
}

export function assertExpectedState(entity, expectedState) {
  if (!expectedState) throw new HttpError(422, 'expected_status is required.', 'EXPECTED_STATE_REQUIRED');
  if (entity.status !== expectedState) {
    throw new HttpError(409, `State changed: expected ${expectedState}, found ${entity.status}.`, 'STALE_STATE');
  }
}

export function assertTransition(table, from, to) {
  if (!(TRANSITIONS[table]?.[from] || []).includes(to)) {
    throw new HttpError(409, `Invalid ${table.slice(0, -1)} transition from ${from} to ${to}.`, 'INVALID_TRANSITION');
  }
}

export async function transitionEntity(db, { table, id, expectedState, nextState }) {
  const entity = await lockEntity(db, table, id);
  if (entity.status === nextState) return { entity, repeated: true };
  assertExpectedState(entity, expectedState);
  assertTransition(table, entity.status, nextState);
  const { rows } = await db.query(`UPDATE ${table} SET status=$1,updated_at=now() WHERE id=$2 RETURNING *`, [nextState, id]);
  return { entity: rows[0], priorState: entity.status, repeated: false };
}
