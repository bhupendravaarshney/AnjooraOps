import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExpectedState, assertTransition } from '../lib/transitions.js';
import { normalizeUnit, requireMatchingUnit } from '../lib/units.js';
import { refillReminderDays } from '../lib/refills.js';

test('allows only declared workflow transitions', () => {
  assert.doesNotThrow(() => assertTransition('orders', 'PAID', 'IN_PRODUCTION'));
  assert.doesNotThrow(() => assertTransition('orders', 'READY_TO_DISPATCH', 'SHIPPED'));
  assert.throws(() => assertTransition('orders', 'AWAITING_ACCEPTANCE', 'SHIPPED'), (error) => error.status === 409);
  assert.throws(() => assertExpectedState({ status: 'PAID' }, 'AWAITING_PAYMENT'), (error) => error.code === 'STALE_STATE');
  assert.throws(() => assertExpectedState({ status: 'PAID' }, ''), (error) => error.status === 422);
});

test('canonical units reject implicit conversions and mismatches', () => {
  assert.equal(normalizeUnit(' KG '), 'kg');
  assert.doesNotThrow(() => requireMatchingUnit('g', 'G'));
  assert.throws(() => requireMatchingUnit('g', 'kg'), (error) => error.code === 'UNIT_MISMATCH');
  assert.throws(() => normalizeUnit('pcs'), (error) => error.status === 422);
});

test('one bounded refill reminder window is used everywhere', () => {
  const original = process.env.REFILL_REMINDER_DAYS_BEFORE;
  process.env.REFILL_REMINDER_DAYS_BEFORE = '6';
  assert.equal(refillReminderDays(), 6);
  process.env.REFILL_REMINDER_DAYS_BEFORE = '120';
  assert.equal(refillReminderDays(), 90);
  process.env.REFILL_REMINDER_DAYS_BEFORE = '-2';
  assert.equal(refillReminderDays(), 0);
  if (original === undefined) delete process.env.REFILL_REMINDER_DAYS_BEFORE;
  else process.env.REFILL_REMINDER_DAYS_BEFORE = original;
});
