import crypto from 'crypto';

export function uuid() {
  return crypto.randomUUID();
}

function stamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function publicId(prefix) {
  // 128 random bits keeps public identifiers unguessable and collisions impractical.
  const suffix = crypto.randomBytes(16).toString('hex').toUpperCase();
  return `${prefix}-${stamp()}-${suffix}`;
}

export function isPublicIdCollision(error) {
  return error?.code === '23505' && /public_id|folio_id/i.test(String(error.constraint || ''));
}

export async function withPublicIdRetry(operation, maximumAttempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (!isPublicIdCollision(error)) throw error;
    }
  }
  throw lastError;
}
