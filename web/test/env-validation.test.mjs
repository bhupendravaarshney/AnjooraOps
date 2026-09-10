import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const relevantNames = [
  'APP_URL', 'NEXT_PUBLIC_APP_URL', 'DATABASE_URL', 'DATABASE_SSL', 'DATABASE_CA_CERT',
  'POSTGRES_PASSWORD', 'SESSION_SECRET', 'ANJOORA_INTEGRATION_SECRET', 'CRON_SECRET',
  'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD',
  'DEPLOYMENT_PROFILE', 'ENABLE_DEMO_FORM', 'REQUIRE_STAFF_MFA', 'ANJOORA_WHATSAPP_NUMBER',
  'PAYMENT_PROVIDER', 'PAYMENT_LINK_BASE_URL', 'PAYMENT_WEBHOOK_SECRET', 'PAYMENT_ADAPTER_ID', 'PAYMENT_EVENT_MAP',
  'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_GRAPH_VERSION',
  'WHATSAPP_TEMPLATE_DISPATCH', 'WHATSAPP_TEMPLATE_DELIVERED', 'WHATSAPP_TEMPLATE_REFILL',
  'GO_LIVE', 'RELEASE_CANDIDATE', 'NEXT_PUBLIC_WHATSAPP_ACCESS_TOKEN',
  'BACKUP_RPO_HOURS', 'BACKUP_RTO_MINUTES',
  'CONSULTATION_CONSENT_VERSION', 'CONSULTATION_CONSENT_TEXT',
  'PRIVACY_IDENTITY_VERIFICATION_METHOD', 'PRIVACY_APPROVAL_ID', 'PRIVACY_APPROVED_AT',
  'CONSULTATION_RAW_PAYLOAD_DAYS', 'WHATSAPP_RAW_PAYLOAD_DAYS', 'WHATSAPP_MESSAGE_BODY_DAYS',
  'PAYMENT_RAW_PAYLOAD_DAYS', 'RATE_LIMIT_EVENT_DAYS', 'OUTBOX_RETENTION_DAYS', 'JOB_RUN_RETENTION_DAYS',
  'AUDIT_RETENTION_DAYS', 'CUSTOMER_RECORD_RETENTION_DAYS',
];

function productionEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of relevantNames) environment[name] = '';
  return {
    ...environment,
    NODE_ENV: 'production',
    APP_URL: 'https://ops.anjoora.in',
    NEXT_PUBLIC_APP_URL: 'https://ops.anjoora.in',
    DATABASE_URL: 'postgresql://anjoora_prod:a-random-database-password@db.anjoora.in/anjoora',
    DATABASE_SSL: 'true',
    SESSION_SECRET: 'session-secret-which-is-random-and-long-0001',
    ANJOORA_INTEGRATION_SECRET: 'integration-secret-which-is-random-long-0002',
    CRON_SECRET: 'scheduler-secret-which-is-random-and-long-0003',
    RELEASE_CANDIDATE: 'anjoora-test-2026.09.09.1',
    ENABLE_DEMO_FORM: 'false',
    REQUIRE_STAFF_MFA: 'true',
    ANJOORA_WHATSAPP_NUMBER: '919876543210',
    PAYMENT_PROVIDER: 'MANUAL',
    BACKUP_RPO_HOURS: '24',
    BACKUP_RTO_MINUTES: '240',
    ...overrides,
  };
}

function validate(overrides = {}) {
  return spawnSync(process.execPath, ['scripts/validate-env.mjs'], {
    cwd: webRoot,
    env: productionEnvironment(overrides),
    encoding: 'utf8',
  });
}

test('accepts a production configuration with verified database TLS', () => {
  const result = validate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /environment validation passed/i);
});

test('rejects production when database TLS verification is disabled', () => {
  const result = validate({ DATABASE_SSL: 'false' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_SSL must be true/);
});

test('rejects placeholder application and database values', () => {
  const appResult = validate({ APP_URL: 'https://your-domain.com' });
  assert.notEqual(appResult.status, 0);
  assert.match(appResult.stderr, /APP_URL must be a real HTTPS endpoint/);

  const databaseResult = validate({ DATABASE_URL: 'postgresql://anjoora:replace-with-password@db.anjoora.in/anjoora' });
  assert.notEqual(databaseResult.status, 0);
  assert.match(databaseResult.stderr, /non-placeholder production credentials/);
});

test('rejects different server and public application origins', () => {
  const result = validate({ NEXT_PUBLIC_APP_URL: 'https://other.anjoora.in' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use the same origin/);
});

test('rejects remaining bootstrap and public-number placeholders', () => {
  const bootstrapResult = validate({
    BOOTSTRAP_ADMIN_EMAIL: 'admin@anjoora.in',
    BOOTSTRAP_ADMIN_PASSWORD: 'replace-with-a-strong-password',
  });
  assert.notEqual(bootstrapResult.status, 0);
  assert.match(bootstrapResult.stderr, /BOOTSTRAP_ADMIN_PASSWORD/);

  const numberResult = validate({ ANJOORA_WHATSAPP_NUMBER: '919999999999' });
  assert.notEqual(numberResult.status, 0);
  assert.match(numberResult.stderr, /non-placeholder country-code number/);
});

test('rejects partial Meta WhatsApp configuration, including a missing Graph version', () => {
  const result = validate({
    WHATSAPP_VERIFY_TOKEN: 'whatsapp-verify-token-which-is-random-0004',
    WHATSAPP_APP_SECRET: 'whatsapp-app-secret-which-is-random-0005',
    WHATSAPP_ACCESS_TOKEN: 'provider-issued-access-token',
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_GRAPH_VERSION: '',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Meta WhatsApp configuration is partial/);
});

test('rejects reuse of a core secret for a provider webhook', () => {
  const result = validate({
    PAYMENT_PROVIDER: 'TESTPAY',
    PAYMENT_LINK_BASE_URL: 'https://checkout.anjoora.in',
    PAYMENT_WEBHOOK_SECRET: 'session-secret-which-is-random-and-long-0001',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PAYMENT_WEBHOOK_SECRET must not reuse SESSION_SECRET/);
});

test('requires an actual external payment-provider name', () => {
  const result = validate({
    PAYMENT_PROVIDER: 'EXTERNAL',
    PAYMENT_LINK_BASE_URL: 'https://checkout.anjoora.in',
    PAYMENT_WEBHOOK_SECRET: 'payment-webhook-secret-which-is-random-0006',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must name the actual provider/);
});

test('keeps the explicit localhost deployment profile usable without database TLS', () => {
  const result = validate({
    APP_URL: 'http://localhost:3000',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://anjoora:local-password@127.0.0.1:5432/anjoora',
    DATABASE_SSL: 'false',
    DEPLOYMENT_PROFILE: 'local',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('never permits the localhost profile to bypass the go-live gate', () => {
  const result = validate({
    GO_LIVE: 'true',
    APP_URL: 'http://localhost:3000',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://anjoora:local-password@127.0.0.1:5432/anjoora',
    DATABASE_SSL: 'false',
    DEPLOYMENT_PROFILE: 'local',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot use DEPLOYMENT_PROFILE=local/);
});

test('go-live mode rejects bootstrap credentials, manual payments, and incomplete Meta activation', () => {
  const bootstrapResult = validate({
    GO_LIVE: 'true',
    BOOTSTRAP_ADMIN_EMAIL: 'owner@anjoora.in',
    BOOTSTRAP_ADMIN_PASSWORD: 'Temporary Owner Password!42-abcdef',
  });
  assert.notEqual(bootstrapResult.status, 0);
  assert.match(bootstrapResult.stderr, /Remove BOOTSTRAP_ADMIN/);

  const paymentResult = validate({ GO_LIVE: 'true' });
  assert.notEqual(paymentResult.status, 0);
  assert.match(paymentResult.stderr, /certified external payment provider/);

  const metaResult = validate({
    GO_LIVE: 'true',
    RELEASE_CANDIDATE: 'anjoora-2026.09.09.1',
    PAYMENT_PROVIDER: 'CERTIFIEDPAY',
    PAYMENT_LINK_BASE_URL: 'https://payments.anjoora.in/checkout',
    PAYMENT_WEBHOOK_SECRET: 'payment-webhook-secret-which-is-random-0006',
    PAYMENT_ADAPTER_ID: 'certifiedpay-normalizer-v1',
    PAYMENT_EVENT_MAP: JSON.stringify({
      pending: 'PENDING', paid: 'PAID', failed: 'FAILED', cancelled: 'CANCELLED', refunded: 'REFUNDED',
    }),
  });
  assert.notEqual(metaResult.status, 0);
  assert.match(metaResult.stderr, /complete Meta WhatsApp production configuration/);
});

test('go-live mode accepts complete provider configuration', () => {
  const result = validate({
    GO_LIVE: 'true',
    PAYMENT_PROVIDER: 'CERTIFIEDPAY',
    PAYMENT_LINK_BASE_URL: 'https://payments.anjoora.in/checkout',
    PAYMENT_WEBHOOK_SECRET: 'payment-webhook-secret-which-is-random-0006',
    PAYMENT_ADAPTER_ID: 'certifiedpay-normalizer-v1',
    PAYMENT_EVENT_MAP: JSON.stringify({
      pending: 'PENDING', paid: 'PAID', failed: 'FAILED', cancelled: 'CANCELLED', refunded: 'REFUNDED',
    }),
    WHATSAPP_VERIFY_TOKEN: 'whatsapp-verify-token-which-is-random-0004',
    WHATSAPP_APP_SECRET: 'whatsapp-app-secret-which-is-random-0005',
    WHATSAPP_ACCESS_TOKEN: 'provider-issued-access-token-which-is-long-enough-0007',
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_BUSINESS_ACCOUNT_ID: '987654321098765',
    WHATSAPP_GRAPH_VERSION: 'v26.0',
    WHATSAPP_TEMPLATE_DISPATCH: 'order_dispatch_v1',
    WHATSAPP_TEMPLATE_DELIVERED: 'order_delivered_v1',
    WHATSAPP_TEMPLATE_REFILL: 'refill_reminder_v1',
    CONSULTATION_CONSENT_VERSION: '2026-09-approved-v1',
    CONSULTATION_CONSENT_TEXT: 'I consent to ANJOORA using these details for the approved consultation, review, contact, recommendation, order, and payment purposes described to me.',
    PRIVACY_IDENTITY_VERIFICATION_METHOD: 'Approved two-factor customer verification procedure PV-1',
    PRIVACY_APPROVAL_ID: 'LEGAL/PRIVACY/2026-09-001',
    PRIVACY_APPROVED_AT: '2026-09-08T12:00:00Z',
    CONSULTATION_RAW_PAYLOAD_DAYS: '30',
    WHATSAPP_RAW_PAYLOAD_DAYS: '30',
    WHATSAPP_MESSAGE_BODY_DAYS: '365',
    PAYMENT_RAW_PAYLOAD_DAYS: '30',
    RATE_LIMIT_EVENT_DAYS: '2',
    OUTBOX_RETENTION_DAYS: '365',
    JOB_RUN_RETENTION_DAYS: '90',
    AUDIT_RETENTION_DAYS: '2555',
    CUSTOMER_RECORD_RETENTION_DAYS: '2555',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('rejects public secret variables and non-verifying database SSL modes', () => {
  const publicSecret = validate({ NEXT_PUBLIC_WHATSAPP_ACCESS_TOKEN: 'must-never-be-public' });
  assert.notEqual(publicSecret.status, 0);
  assert.match(publicSecret.stderr, /must never use NEXT_PUBLIC/);

  const sslMode = validate({
    DATABASE_URL: 'postgresql://anjoora_prod:a-random-database-password@db.anjoora.in/anjoora?sslmode=require',
  });
  assert.notEqual(sslMode.status, 0);
  assert.match(sslMode.stderr, /sslmode must be verify-full/);
});
