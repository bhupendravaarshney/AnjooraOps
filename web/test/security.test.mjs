import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, passwordPolicyError, verifyPassword,
} from '../lib/security.js';

test('password hashes verify and policy rejects weak values', () => {
  const stored = hashPassword('Strong Example!42');
  assert.equal(verifyPassword('Strong Example!42', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(passwordPolicyError('short'), 'Password must contain 12–128 characters.');
  assert.equal(passwordPolicyError('Strong Example!42'), null);
});
