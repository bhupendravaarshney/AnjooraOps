import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../lib/phone.js';

test('normalizes supported Indian mobile forms', () => {
  assert.equal(normalizePhone('98765 43210'), '919876543210');
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalizePhone('09876543210'), '919876543210');
});

test('rejects implausible and malformed phones', () => {
  for (const value of ['12345', '5123456789', '0091ABC98765', '+12+34567890', '0000000000']) {
    assert.equal(normalizePhone(value), '', value);
  }
});

test('accepts international E.164-sized numbers', () => {
  assert.equal(normalizePhone('+14155552671'), '14155552671');
});
