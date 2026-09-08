import crypto from 'crypto';

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(error) {
  if (error instanceof HttpError) {
    const headers = error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined;
    return Response.json({ ok: false, error: error.message, code: error.code }, { status: error.status, headers });
  }
  console.error('Unhandled request error', error);
  return Response.json({ ok: false, error: 'The request could not be completed.' }, { status: 500 });
}

export async function readJsonBody(request, maximumBytes = 32_768) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > maximumBytes) throw new HttpError(413, 'Request body is too large.', 'BODY_TOO_LARGE');
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > maximumBytes) throw new HttpError(413, 'Request body is too large.', 'BODY_TOO_LARGE');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON.', 'INVALID_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'JSON body must be an object.', 'INVALID_JSON');
  }
  return value;
}

export function correlationId(request) {
  const supplied = String(request?.headers?.get('x-request-id') || '').trim();
  return /^[a-zA-Z0-9._:-]{8,100}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export function requestIp(request, { trustIntegrationHeader = false } = {}) {
  if (trustIntegrationHeader) {
    const forwardedClient = String(request.headers.get('x-anjoora-client-ip') || '').split(',')[0].trim();
    if (forwardedClient) return forwardedClient.slice(0, 128);
  }
  return String(request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 128);
}

export function hashPrivateValue(value) {
  const pepper = process.env.SESSION_SECRET || 'development-only-no-pepper';
  return crypto.createHmac('sha256', pepper).update(String(value || 'unknown')).digest('hex');
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export function requireSameOrigin(request) {
  const origin = request.headers.get('origin');
  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  const allowed = new Set([requestOrigin]);
  if (configuredOrigin) {
    try { allowed.add(new URL(configuredOrigin).origin); } catch { /* invalid configuration is not trusted */ }
  }
  if (!origin || !allowed.has(origin)) {
    throw new HttpError(403, 'Request origin could not be verified.', 'CSRF_ORIGIN_REJECTED');
  }
}
