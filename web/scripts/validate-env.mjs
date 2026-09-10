import { X509Certificate } from 'node:crypto';
import './load-env.mjs';
import { parsePaymentEventMap } from '../lib/payment.js';

function fail(message) { throw new Error(`Configuration error: ${message}`); }
function placeholder(value) {
  return /placeholder|replace|change.?me|your-domain|example(?:\.|$)/i.test(String(value || ''));
}
function reservedEndpointHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return placeholder(value)
    || ['localhost', '127.0.0.1', '::1'].includes(value)
    || /\.(?:invalid|localhost|test)$/.test(value);
}
function strong(name) {
  const value = process.env[name] || '';
  if (value.length < 32 || placeholder(value)) fail(`${name} must be an independent random value of at least 32 characters.`);
}
function requireDistinctSecrets(names) {
  const seen = new Map();
  for (const name of names) {
    const value = process.env[name];
    if (!value) continue;
    if (seen.has(value)) fail(`${name} must not reuse ${seen.get(value)}.`);
    seen.set(value, name);
  }
}
function httpsUrl(name) {
  let parsed;
  try { parsed = new URL(process.env[name]); } catch { fail(`${name} must be an absolute URL.`); }
  if (parsed.protocol !== 'https:' || reservedEndpointHost(parsed.hostname)) fail(`${name} must be a real HTTPS endpoint.`);
  return parsed;
}
function positiveNumber(name) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) fail(`${name} must be a positive number.`);
  return value;
}
function integerInRange(name, minimum, maximum) {
  const raw = process.env[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function rejectPublicSecrets() {
  const sensitive = /(?:SECRET|TOKEN|PASSWORD|PRIVATE|DATABASE|ACCESS_KEY|API_KEY)/;
  const leaked = Object.entries(process.env)
    .filter(([name, value]) => name.startsWith('NEXT_PUBLIC_') && sensitive.test(name) && Boolean(value))
    .map(([name]) => name);
  if (leaked.length) fail(`Sensitive values must never use NEXT_PUBLIC_* variables: ${leaked.join(', ')}.`);
}

rejectPublicSecrets();

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required.');
let databaseUrl;
try { databaseUrl = new URL(process.env.DATABASE_URL); } catch { fail('DATABASE_URL must be a valid PostgreSQL URL.'); }
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) fail('DATABASE_URL must use the postgres or postgresql scheme.');
if (process.env.NODE_ENV === 'production') {
  if (process.env.GO_LIVE && !['true', 'false'].includes(process.env.GO_LIVE)) fail('GO_LIVE must be true or false.');
  const goLive = process.env.GO_LIVE === 'true';
  strong('SESSION_SECRET');
  strong('ANJOORA_INTEGRATION_SECRET');
  strong('CRON_SECRET');
  requireDistinctSecrets(['SESSION_SECRET', 'ANJOORA_INTEGRATION_SECRET', 'CRON_SECRET']);
  const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  let parsed;
  try { parsed = new URL(appUrl); } catch { fail('APP_URL must be an absolute URL.'); }
  const localProfile = process.env.DEPLOYMENT_PROFILE === 'local';
  if (goLive && localProfile) fail('GO_LIVE=true cannot use DEPLOYMENT_PROFILE=local.');
  if (localProfile) {
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) fail('The local deployment profile is only valid on localhost.');
  } else {
    const appUrl = httpsUrl('APP_URL');
    const publicAppUrl = httpsUrl('NEXT_PUBLIC_APP_URL');
    if (appUrl.origin !== publicAppUrl.origin) fail('APP_URL and NEXT_PUBLIC_APP_URL must use the same origin.');
    if (process.env.DATABASE_SSL !== 'true') fail('DATABASE_SSL must be true in production so the database certificate is verified.');
    const sslMode = databaseUrl.searchParams.get('sslmode');
    if (sslMode && sslMode !== 'verify-full') {
      fail('DATABASE_URL sslmode must be verify-full when supplied; prefer DATABASE_SSL=true with DATABASE_CA_CERT.');
    }
    if (!databaseUrl.username || !databaseUrl.password || placeholder(databaseUrl.hostname) || placeholder(decodeURIComponent(databaseUrl.username)) || placeholder(decodeURIComponent(databaseUrl.password)) || /anjoora:anjoora@/i.test(process.env.DATABASE_URL)) {
      fail('DATABASE_URL must contain non-placeholder production credentials.');
    }
    if (process.env.DATABASE_CA_CERT) {
      try { new X509Certificate(process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n')); } catch {
        fail('DATABASE_CA_CERT must contain a valid PEM X.509 certificate.');
      }
    }
    if (process.env.POSTGRES_PASSWORD && placeholder(process.env.POSTGRES_PASSWORD)) fail('POSTGRES_PASSWORD contains a placeholder value.');
    const configuredBootstrapKeys = ['BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD'].filter((name) => Boolean(process.env[name]));
    if (configuredBootstrapKeys.length === 1) fail('Set both BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD or remove both after provisioning.');
    if (configuredBootstrapKeys.length === 2) strong('BOOTSTRAP_ADMIN_PASSWORD');
    if (goLive && configuredBootstrapKeys.length) fail('Remove BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD before setting GO_LIVE=true.');
    if (goLive) {
      positiveNumber('BACKUP_RPO_HOURS');
      positiveNumber('BACKUP_RTO_MINUTES');
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{2,119}$/.test(process.env.RELEASE_CANDIDATE || '') || placeholder(process.env.RELEASE_CANDIDATE)) {
        fail('RELEASE_CANDIDATE must identify the immutable release build when GO_LIVE=true.');
      }
    }
    if (process.env.ENABLE_DEMO_FORM === 'true') fail('ENABLE_DEMO_FORM must be false in production.');
    if (!/^\d{10,15}$/.test(process.env.ANJOORA_WHATSAPP_NUMBER || '') || process.env.ANJOORA_WHATSAPP_NUMBER === '919999999999') {
      fail('ANJOORA_WHATSAPP_NUMBER must contain a non-placeholder country-code number.');
    }

    const paymentProvider = String(process.env.PAYMENT_PROVIDER || '').trim().toUpperCase();
    if (!paymentProvider) fail('PAYMENT_PROVIDER must be explicitly set to MANUAL or the configured external provider.');
    if (!/^[A-Z0-9][A-Z0-9._-]{1,79}$/.test(paymentProvider)) fail('PAYMENT_PROVIDER must be a 2-80 character provider identifier.');
    if (paymentProvider === 'EXTERNAL') fail('PAYMENT_PROVIDER must name the actual provider or be explicitly set to MANUAL.');
    if (goLive && paymentProvider === 'MANUAL') fail('GO_LIVE=true requires the certified external payment provider, not MANUAL.');
    if (paymentProvider !== 'MANUAL') {
      strong('PAYMENT_WEBHOOK_SECRET');
      httpsUrl('PAYMENT_LINK_BASE_URL');
      try { parsePaymentEventMap(process.env.PAYMENT_EVENT_MAP, { requireCoverage: goLive }); } catch (error) { fail(error.message); }
      if (goLive && (!process.env.PAYMENT_ADAPTER_ID || placeholder(process.env.PAYMENT_ADAPTER_ID))) {
        fail('PAYMENT_ADAPTER_ID must identify the reviewed provider adapter version when GO_LIVE=true.');
      }
    }

    const whatsappKeys = [
      'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID',
    ];
    const configuredWhatsAppKeys = whatsappKeys.filter((name) => Boolean(process.env[name]));
    if (configuredWhatsAppKeys.length && configuredWhatsAppKeys.length !== whatsappKeys.length) {
      fail(`Meta WhatsApp configuration is partial; set all of ${whatsappKeys.join(', ')} or none of them.`);
    }
    if (configuredWhatsAppKeys.length) {
      if (!process.env.WHATSAPP_GRAPH_VERSION) fail('Meta WhatsApp configuration is partial; WHATSAPP_GRAPH_VERSION is required when Cloud API credentials are set.');
      strong('WHATSAPP_VERIFY_TOKEN');
      strong('WHATSAPP_APP_SECRET');
      if (process.env.WHATSAPP_ACCESS_TOKEN.length < 40 || placeholder(process.env.WHATSAPP_ACCESS_TOKEN)) {
        fail('WHATSAPP_ACCESS_TOKEN must contain the real server-side provider token.');
      }
      if (!/^\d+$/.test(process.env.WHATSAPP_PHONE_NUMBER_ID)) fail('WHATSAPP_PHONE_NUMBER_ID must contain digits only.');
      if (!/^\d+$/.test(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID)) fail('WHATSAPP_BUSINESS_ACCOUNT_ID must contain digits only.');
      if (!/^v\d+\.\d+$/.test(process.env.WHATSAPP_GRAPH_VERSION)) fail('WHATSAPP_GRAPH_VERSION must use a value such as v26.0.');
    }
    if (goLive && configuredWhatsAppKeys.length !== whatsappKeys.length) {
      fail('GO_LIVE=true requires the complete Meta WhatsApp production configuration.');
    }
    if (goLive) {
      for (const name of ['WHATSAPP_TEMPLATE_DISPATCH', 'WHATSAPP_TEMPLATE_DELIVERED', 'WHATSAPP_TEMPLATE_REFILL']) {
        if (!process.env[name] || placeholder(process.env[name])) fail(`${name} must name an approved Meta template when GO_LIVE=true.`);
      }
      const consentVersion = String(process.env.CONSULTATION_CONSENT_VERSION || '').trim();
      const consentText = String(process.env.CONSULTATION_CONSENT_TEXT || '').trim();
      if (!/^[A-Za-z0-9._-]{3,80}$/.test(consentVersion)) fail('CONSULTATION_CONSENT_VERSION must identify the approved text.');
      if (consentText.length < 40 || consentText.length > 1000 || placeholder(consentText)) fail('CONSULTATION_CONSENT_TEXT must contain the approved 40-1000 character text.');
      const verificationMethod = String(process.env.PRIVACY_IDENTITY_VERIFICATION_METHOD || '').trim();
      if (verificationMethod.length < 5 || verificationMethod.length > 200 || placeholder(verificationMethod)) fail('PRIVACY_IDENTITY_VERIFICATION_METHOD must contain the approved procedure name.');
      if (!/^[A-Za-z0-9._:/-]{3,120}$/.test(process.env.PRIVACY_APPROVAL_ID || '')) fail('PRIVACY_APPROVAL_ID must identify the legal/privacy approval record.');
      const approvedAt = new Date(process.env.PRIVACY_APPROVED_AT || '');
      if (Number.isNaN(approvedAt.getTime()) || approvedAt > new Date()) fail('PRIVACY_APPROVED_AT must be a valid past ISO-8601 date or timestamp.');
      integerInRange('CONSULTATION_RAW_PAYLOAD_DAYS', 1, 3650);
      integerInRange('WHATSAPP_RAW_PAYLOAD_DAYS', 1, 3650);
      integerInRange('WHATSAPP_MESSAGE_BODY_DAYS', 30, 3650);
      integerInRange('PAYMENT_RAW_PAYLOAD_DAYS', 1, 3650);
      integerInRange('RATE_LIMIT_EVENT_DAYS', 1, 3650);
      integerInRange('OUTBOX_RETENTION_DAYS', 30, 3650);
      integerInRange('JOB_RUN_RETENTION_DAYS', 7, 3650);
      integerInRange('AUDIT_RETENTION_DAYS', 365, 3650);
      integerInRange('CUSTOMER_RECORD_RETENTION_DAYS', 365, 3650);
    }
    requireDistinctSecrets([
      'SESSION_SECRET', 'ANJOORA_INTEGRATION_SECRET', 'CRON_SECRET', 'BOOTSTRAP_ADMIN_PASSWORD',
      'PAYMENT_WEBHOOK_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN',
    ]);
  }
}

console.log(`ANJOORA environment validation passed (${process.env.GO_LIVE === 'true' ? 'go-live' : 'pre-live'} mode).`);
