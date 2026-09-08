import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptSecret, encryptSecret, generateMfaSecret, hashPassword,
  passwordPolicyError, totpCode, verifyPassword, verifyTotp,
} from '../lib/security.js';

test('password hashes verify and policy rejects weak values', () => {
  const stored = hashPassword('Strong Example!42');
  assert.equal(verifyPassword('Strong Example!42', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(passwordPolicyError('short'), 'Password must contain 12–128 characters.');
  assert.equal(passwordPolicyError('Strong Example!42'), null);
});

test('TOTP accepts current code and encrypted secrets round trip', () => {
  process.env.SESSION_SECRET = 'unit-test-session-secret-with-at-least-32-characters';
  const secret = generateMfaSecret();
  const encrypted = encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptSecret(encrypted), secret);
  assert.equal(verifyTotp(secret, totpCode(secret)), true);
  assert.equal(verifyTotp(secret, '00000x'), false);
});
