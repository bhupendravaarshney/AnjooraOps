import crypto from 'crypto';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function passwordPolicyError(password) {
  const value = String(password || '');
  if (value.length < 12 || value.length > 128) return 'Password must contain 12–128 characters.';
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    return 'Password must include uppercase, lowercase, number, and symbol characters.';
  }
  return null;
}

export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function verifyMetaSignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
