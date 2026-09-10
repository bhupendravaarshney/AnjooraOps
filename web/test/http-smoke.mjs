import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

function readEnvironment(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return [key, value];
    }));
}

function assertLocalUrl(value, label) {
  const parsed = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && process.env.ALLOW_REMOTE_HTTP_SMOKE !== 'true') {
    throw new Error(`${label} must point to localhost. Set ALLOW_REMOTE_HTTP_SMOKE=true only for an isolated test deployment.`);
  }
  return parsed;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

function assertSameOriginRedirect(response, label) {
  const location = response.headers.get('location');
  assert.ok(
    location?.startsWith('/') && !location.startsWith('//'),
    `${label} must return a relative same-origin Location header; received ${location || 'none'}.`,
  );
}

function testPhone() {
  return `919${crypto.randomInt(100_000_000, 1_000_000_000)}`;
}

let activeConsentVersion = '2026-09-v1';
function consultationPayload(phone) {
  return {
    submission_id: crypto.randomUUID(),
    name: 'Ananya Test',
    whatsapp: `+${phone}`,
    city: 'Test City',
    language: 'Hinglish',
    best_time_to_message: 'Afternoon',
    primary_concern: 'Sleep',
    concerns: ['Calm', 'Sleep'],
    preferred_format: 'Botanical infusion',
    safety_flags: ['none'],
    questionnaire_version: '1.0',
    safety_screen_version: '1.0',
    consent: true,
    consent_version: activeConsentVersion,
  };
}

const projectRoot = path.resolve(process.cwd(), '..');
const fileEnvironment = readEnvironment(path.join(projectRoot, '.env'));
const environment = { ...fileEnvironment, ...process.env };
const opsUrl = assertLocalUrl(environment.OPS_SMOKE_URL || 'http://127.0.0.1:3000', 'OPS_SMOKE_URL');
const frontendUrl = assertLocalUrl(environment.ANJOORA_SMOKE_URL || 'http://127.0.0.1:3001', 'ANJOORA_SMOKE_URL');
const appOrigin = new URL(environment.APP_URL || environment.NEXT_PUBLIC_APP_URL || opsUrl).origin;
const integrationSecret = environment.ANJOORA_INTEGRATION_SECRET;
const whatsappSecret = environment.WHATSAPP_APP_SECRET;
const sessionSecret = environment.SESSION_SECRET || 'development-only-no-pepper';
if (!integrationSecret) throw new Error('ANJOORA_INTEGRATION_SECRET is required for the HTTP smoke test.');
if (!whatsappSecret) throw new Error('WHATSAPP_APP_SECRET is required for the webhook smoke test.');
if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for smoke-test assertions and cleanup.');

const databaseUrl = new URL(environment.DATABASE_URL);
if (databaseUrl.hostname === 'postgres') databaseUrl.hostname = '127.0.0.1';
assertLocalUrl(databaseUrl.toString(), 'DATABASE_URL');

const directPhone = testPhone();
let frontendPhone = testPhone();
while (frontendPhone === directPhone) frontendPhone = testPhone();
let webhookPhone = testPhone();
while ([directPhone, frontendPhone].includes(webhookPhone)) webhookPhone = testPhone();

const requestMarker = crypto.randomUUID();
const directIp = `198.51.100.${crypto.randomInt(1, 255)}`;
const invalidIp = `203.0.113.${crypto.randomInt(1, 255)}`;
const frontendIp = `192.0.2.${crypto.randomInt(1, 255)}`;
const loginIp = `198.18.0.${crypto.randomInt(1, 255)}`;
const directRequestId = `smoke-direct-${requestMarker}`;
const invalidRequestId = `smoke-invalid-${requestMarker}`;
const rbacRequestId = `smoke-rbac-${requestMarker}`;
const metaMessageId = `wamid.smoke.${requestMarker}`;
const statusMetaMessageId = `wamid.smoke.status.${requestMarker}`;
const statusOutboxKey = `status-smoke:${requestMarker}`;
const databaseSsl = environment.DATABASE_SSL === 'true'
  ? { rejectUnauthorized: true, ...(environment.DATABASE_CA_CERT ? { ca: environment.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) }
  : undefined;
const client = new Client({ connectionString: databaseUrl.toString(), ssl: databaseSsl });
let clientConnected = false;
const consultationEntityIds = [];
const supportStaffId = crypto.randomUUID();
const supportEmail = `support-${requestMarker}@example.test`;
const supportPassword = 'Smoke Support!42';
const adminStaffId = crypto.randomUUID();
const managedSupportEmail = `named-support-${requestMarker}@example.test`;
let managedSupportId = null;
const catalogueInventoryId = crypto.randomUUID();
const catalogueIngredientId = crypto.randomUUID();
const catalogueSku = `SMOKE-RM-${requestMarker.slice(0, 8).toUpperCase()}`;
let createdFormulaId = null;
let createdRecommendationId = null;

function rateLimitHash(scope, key) {
  return crypto.createHmac('sha256', sessionSecret).update(`${scope}:${key}`).digest('hex');
}

try {
  await client.connect();
  clientConnected = true;

  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${passwordSalt}:${crypto.scryptSync(supportPassword, passwordSalt, 64).toString('hex')}`;
  await client.query(`
    INSERT INTO staff_users(id,email,name,password_hash,role,must_rotate_password)
    VALUES($1,$2,'Smoke Support',$3,'SUPPORT',false)
  `, [supportStaffId, supportEmail, passwordHash]);
  await client.query(`
    INSERT INTO staff_users(id,email,name,password_hash,role,must_rotate_password,mfa_enabled)
    VALUES($1,$2,'Smoke Administrator',$3,'ADMIN',false,true)
  `, [adminStaffId, `admin-${requestMarker}@example.test`, passwordHash]);
  await client.query(`
    INSERT INTO inventory_items(id,public_id,sku,name,unit,reorder_level)
    VALUES($1,$2,$3,'Authoritative smoke ingredient','g',0)
  `, [catalogueInventoryId, `ANJ-INV-SMOKE-${requestMarker}`, catalogueSku]);
  await client.query(`
    INSERT INTO formula_ingredients(id,public_id,inventory_item_id,name)
    VALUES($1,$2,$3,'Catalogue smoke ingredient')
  `, [catalogueIngredientId, `ANJ-FING-SMOKE-${requestMarker}`, catalogueInventoryId]);

  const health = await fetch(new URL('/api/health', opsUrl), { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200, 'Ops health endpoint should return 200.');
  assert.ok(health.headers.get('content-security-policy'), 'Content-Security-Policy header should be present.');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options should be nosniff.');

  const opsConsent = await jsonRequest(new URL('/api/v1/consent', opsUrl));
  assert.equal(opsConsent.response.status, 200, 'Ops consent policy should be available.');
  assert.ok(opsConsent.body?.version && opsConsent.body?.text, 'Ops consent policy should include version and text.');
  activeConsentVersion = opsConsent.body.version;
  if (environment.SKIP_ANJOORA_SMOKE !== 'true') {
    const frontendConsent = await jsonRequest(new URL('/api/consultations', frontendUrl));
    assert.equal(frontendConsent.response.status, 200, 'Anjoora should proxy the current consent policy.');
    assert.deepEqual(frontendConsent.body, opsConsent.body, 'Anjoora must display the exact Ops consent policy.');
  }

  const unauthenticated = await jsonRequest(new URL('/api/v1/consultations', opsUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(consultationPayload(directPhone)),
  });
  assert.equal(unauthenticated.response.status, 401, `Unauthenticated intake returned ${unauthenticated.response.status}: ${JSON.stringify(unauthenticated.body)}`);

  const noOriginLogin = await fetch(new URL('/api/auth/login', opsUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'nobody@example.test', password: 'Invalid-password-1!' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(noOriginLogin.status, 403, 'Login without an Origin header should be rejected.');

  const supportLogin = await fetch(new URL('/api/auth/login', opsUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: appOrigin,
      'X-Forwarded-For': loginIp,
    },
    body: new URLSearchParams({ email: supportEmail, password: supportPassword }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(supportLogin.status, 303, 'Valid support login should create a session.');
  assertSameOriginRedirect(supportLogin, 'Valid support login');
  const sessionCookie = String(supportLogin.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(sessionCookie.includes('='), 'Login should set a session cookie.');
  const forbiddenInventory = await jsonRequest(new URL('/api/admin/inventory', opsUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: appOrigin,
      Cookie: sessionCookie,
      'X-Request-Id': rbacRequestId,
    },
    body: new URLSearchParams({ action: 'create_item' }),
  });
  assert.equal(forbiddenInventory.response.status, 403, 'A support user must not mutate inventory.');
  const forbiddenStaffManagement = await jsonRequest(new URL('/api/admin/staff', opsUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: appOrigin,
      Cookie: sessionCookie,
      'X-Request-Id': rbacRequestId,
    },
    body: new URLSearchParams({ action: 'create' }),
  });
  assert.equal(forbiddenStaffManagement.response.status, 403, 'A support user must not manage staff accounts.');

  const sessionCookieName = sessionCookie.split('=')[0];
  const administratorToken = crypto.randomBytes(32).toString('base64url');
  await client.query(`
    INSERT INTO sessions(id,staff_user_id,token_hash,expires_at)
    VALUES($1,$2,$3,now()+interval '1 hour')
  `, [crypto.randomUUID(), adminStaffId, crypto.createHash('sha256').update(administratorToken).digest('hex')]);
  const administratorCookie = `${sessionCookieName}=${administratorToken}`;
  const staffPage = await fetch(new URL('/admin/staff', opsUrl), {
    headers: { Cookie: administratorCookie }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  assert.equal(staffPage.status, 200, 'An administrator should be able to open staff management.');
  const staffPageBody = await staffPage.text();
  assert.ok(staffPageBody.includes('Dashboard and WhatsApp only'), 'Staff management should explain SUPPORT tab access.');
  const createSupport = await fetch(new URL('/api/admin/staff', opsUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: appOrigin,
      Cookie: administratorCookie,
      'X-Request-Id': `staff-${requestMarker}`,
    },
    body: new URLSearchParams({
      action: 'create', name: 'Named Support Smoke', email: managedSupportEmail,
      role: 'SUPPORT', temporary_password: 'Named Support!42',
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(createSupport.status, 303, 'An administrator should be able to create a named support account.');
  assertSameOriginRedirect(createSupport, 'Staff creation');
  const managedSupport = await client.query(`
    SELECT id,role,active,must_rotate_password,mfa_enabled
    FROM staff_users WHERE email=$1
  `, [managedSupportEmail]);
  assert.equal(managedSupport.rowCount, 1);
  managedSupportId = managedSupport.rows[0].id;
  assert.deepEqual({
    role: managedSupport.rows[0].role,
    active: managedSupport.rows[0].active,
    must_rotate_password: managedSupport.rows[0].must_rotate_password,
    mfa_enabled: managedSupport.rows[0].mfa_enabled,
  }, { role: 'SUPPORT', active: true, must_rotate_password: true, mfa_enabled: false });
  const staffCreationAudit = await client.query(`
    SELECT action FROM audit_events
    WHERE entity_type='STAFF_USER' AND entity_id=$1 AND staff_user_id=$2 AND action='CREATED'
  `, [managedSupportId, adminStaffId]);
  assert.equal(staffCreationAudit.rowCount, 1, 'Staff creation should be attributed to the administrator.');

  const payload = consultationPayload(directPhone);
  const intakeHeaders = {
    'Content-Type': 'application/json',
    'X-Anjoora-Integration-Key': integrationSecret,
    'X-Anjoora-Client-Ip': directIp,
    'X-Request-Id': directRequestId,
  };
  const created = await jsonRequest(new URL('/api/v1/consultations', opsUrl), {
    method: 'POST', headers: intakeHeaders, body: JSON.stringify(payload),
  });
  assert.equal(created.response.status, 201, `Initial intake returned ${created.response.status}: ${JSON.stringify(created.body)}`);
  assert.equal(created.response.headers.get('idempotent-replayed'), 'false');

  const replayed = await jsonRequest(new URL('/api/v1/consultations', opsUrl), {
    method: 'POST', headers: intakeHeaders, body: JSON.stringify(payload),
  });
  assert.equal(replayed.response.status, 200, `Intake replay returned ${replayed.response.status}: ${JSON.stringify(replayed.body)}`);
  assert.equal(replayed.response.headers.get('idempotent-replayed'), 'true');
  assert.equal(replayed.body.consultation_id, created.body.consultation_id, 'Replay should return the original consultation.');

  const recommendationContext = await client.query(`
    SELECT c.id,rc.id review_case_id
    FROM consultations c JOIN review_cases rc ON rc.consultation_id=c.id
    WHERE c.submission_id=$1
  `, [payload.submission_id]);
  assert.equal(recommendationContext.rowCount, 1);
  await client.query(`UPDATE review_cases SET status='READY_FOR_RECOMMENDATION',updated_at=now() WHERE id=$1`, [recommendationContext.rows[0].review_case_id]);
  const recommendationPage = await fetch(new URL(`/admin/consultations/${recommendationContext.rows[0].id}`, opsUrl), {
    headers: { Cookie: administratorCookie }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  assert.equal(recommendationPage.status, 200, 'An administrator should be able to open recommendation creation.');
  const recommendationPageBody = await recommendationPage.text();
  assert.ok(recommendationPageBody.includes('name="formula_ingredient_id"'), 'Recommendation creation should render catalogue ingredient dropdowns.');
  assert.ok(recommendationPageBody.includes(catalogueSku), 'The ingredient dropdown should be fetched from the database catalogue.');
  const recommendationForm = new URLSearchParams({
    consultation_id: recommendationContext.rows[0].id,
    expected_review_status: 'READY_FOR_RECOMMENDATION',
    summary: 'Personalised smoke recommendation',
    fulfillment_type: 'PERSONALISED',
    duration_days: '30',
    formula_name: 'Smoke formula',
    formula_format: 'infusion',
    usage_instructions: 'Smoke instructions',
  });
  recommendationForm.append('formula_ingredient_id', catalogueIngredientId);
  recommendationForm.append('formula_ingredient_quantity', '12.5');
  const recommendationCreation = await fetch(new URL('/api/admin/recommendations', opsUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: appOrigin,
      Cookie: administratorCookie,
      'X-Request-Id': `recommendation-${requestMarker}`,
    },
    body: recommendationForm,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(recommendationCreation.status, 303, 'A catalogue-backed personalised recommendation should be created.');
  assertSameOriginRedirect(recommendationCreation, 'Recommendation creation');
  const storedFormulaItem = await client.query(`
    SELECT r.id recommendation_id,r.formula_id,fi.formula_ingredient_id,
           fi.inventory_item_id,fi.ingredient_name,fi.quantity,fi.unit
    FROM recommendations r
    JOIN formula_items fi ON fi.formula_id=r.formula_id
    WHERE r.consultation_id=$1 AND r.is_current=true
  `, [recommendationContext.rows[0].id]);
  assert.equal(storedFormulaItem.rowCount, 1);
  createdRecommendationId = storedFormulaItem.rows[0].recommendation_id;
  createdFormulaId = storedFormulaItem.rows[0].formula_id;
  assert.equal(storedFormulaItem.rows[0].formula_ingredient_id, catalogueIngredientId);
  assert.equal(storedFormulaItem.rows[0].inventory_item_id, catalogueInventoryId);
  assert.equal(storedFormulaItem.rows[0].ingredient_name, 'Catalogue smoke ingredient');
  assert.equal(Number(storedFormulaItem.rows[0].quantity), 12.5);
  assert.equal(storedFormulaItem.rows[0].unit, 'g');

  const invalid = await jsonRequest(new URL('/api/v1/consultations', opsUrl), {
    method: 'POST',
    headers: {
      ...intakeHeaders,
      'X-Anjoora-Client-Ip': invalidIp,
      'X-Request-Id': invalidRequestId,
    },
    body: JSON.stringify(consultationPayload('12345')),
  });
  assert.equal(invalid.response.status, 422, `Invalid phone returned ${invalid.response.status}: ${JSON.stringify(invalid.body)}`);

  if (environment.SKIP_ANJOORA_SMOKE !== 'true') {
    const frontendPayload = consultationPayload(frontendPhone);
    const frontend = await jsonRequest(new URL('/api/consultations', frontendUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': frontendIp },
      body: JSON.stringify(frontendPayload),
    });
    assert.equal(frontend.response.status, 201, `Anjoora proxy returned ${frontend.response.status}: ${JSON.stringify(frontend.body)}`);
    assert.equal(frontend.body.ok, true, 'Anjoora proxy should return the Ops success response.');
  }

  const webhookPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'smoke-account',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          contacts: [{ profile: { name: 'Webhook Test' }, wa_id: webhookPhone }],
          messages: [{ from: webhookPhone, id: metaMessageId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'consultation status' } }],
        },
      }],
    }],
  };
  const rawWebhook = JSON.stringify(webhookPayload);
  const signature = `sha256=${crypto.createHmac('sha256', whatsappSecret).update(rawWebhook).digest('hex')}`;
  const webhookHeaders = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature };
  const firstWebhook = await jsonRequest(new URL('/api/webhooks/whatsapp', opsUrl), {
    method: 'POST', headers: webhookHeaders, body: rawWebhook,
  });
  assert.equal(firstWebhook.response.status, 200, `First webhook returned ${firstWebhook.response.status}: ${JSON.stringify(firstWebhook.body)}`);
  assert.equal(firstWebhook.body.stored, 1);
  assert.equal(firstWebhook.body.duplicates, 0);

  const duplicateWebhook = await jsonRequest(new URL('/api/webhooks/whatsapp', opsUrl), {
    method: 'POST', headers: webhookHeaders, body: rawWebhook,
  });
  assert.equal(duplicateWebhook.response.status, 200, `Duplicate webhook returned ${duplicateWebhook.response.status}: ${JSON.stringify(duplicateWebhook.body)}`);
  assert.equal(duplicateWebhook.body.stored, 0);
  assert.equal(duplicateWebhook.body.duplicates, 1);

  const webhookContext = await client.query(`
    SELECT conversation_id FROM whatsapp_messages WHERE meta_message_id=$1
  `, [metaMessageId]);
  assert.equal(webhookContext.rowCount, 1);
  const statusMessageId = crypto.randomUUID();
  await client.query(`
    INSERT INTO whatsapp_messages(id,conversation_id,meta_message_id,direction,message_type,body,delivery_status)
    VALUES($1,$2,$3,'OUTBOUND','text','status callback smoke','SENT')
  `, [statusMessageId, webhookContext.rows[0].conversation_id, statusMetaMessageId]);
  await client.query(`
    INSERT INTO message_outbox(id,job_type,dedupe_key,status,payload,attempts,processed_at)
    VALUES($1,'WHATSAPP_TEXT',$2,'SENT',$3::jsonb,1,now())
  `, [crypto.randomUUID(), statusOutboxKey, JSON.stringify({ messageId: statusMessageId })]);
  const statusPayload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'smoke-account',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          statuses: [{
            id: statusMetaMessageId,
            status: 'failed',
            timestamp: String(Math.floor(Date.now() / 1000)),
            errors: [{ title: 'Smoke delivery failure' }],
          }],
        },
      }],
    }],
  };
  const rawStatus = JSON.stringify(statusPayload);
  const statusSignature = `sha256=${crypto.createHmac('sha256', whatsappSecret).update(rawStatus).digest('hex')}`;
  const statusCallback = await jsonRequest(new URL('/api/webhooks/whatsapp', opsUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': statusSignature },
    body: rawStatus,
  });
  assert.equal(statusCallback.response.status, 200, `Status callback returned ${statusCallback.response.status}: ${JSON.stringify(statusCallback.body)}`);
  assert.equal(statusCallback.body.statuses, 1);
  const failedDelivery = await client.query(`SELECT delivery_status,last_error FROM whatsapp_messages WHERE meta_message_id=$1`, [statusMetaMessageId]);
  assert.equal(failedDelivery.rows[0].delivery_status, 'FAILED', 'A Meta failure callback must remain visible after API acceptance.');
  assert.equal(failedDelivery.rows[0].last_error, 'Smoke delivery failure');
  const requeuedDelivery = await client.query(`SELECT status,last_error FROM message_outbox WHERE dedupe_key=$1`, [statusOutboxKey]);
  assert.equal(requeuedDelivery.rows[0].status, 'FAILED', 'A Meta failure callback should make the accepted outbox job retryable.');

  const directRows = await client.query(`SELECT id FROM consultations WHERE submission_id=$1`, [payload.submission_id]);
  assert.equal(directRows.rowCount, 1, 'Direct intake should persist exactly one consultation.');
  consultationEntityIds.push(...directRows.rows.map((row) => row.id));
  const frontendRows = await client.query(`SELECT c.id FROM consultations c JOIN customers cu ON cu.id=c.customer_id WHERE cu.phone=$1`, [frontendPhone]);
  if (environment.SKIP_ANJOORA_SMOKE !== 'true') assert.equal(frontendRows.rowCount, 1, 'Anjoora proxy should persist exactly one consultation.');
  consultationEntityIds.push(...frontendRows.rows.map((row) => row.id));
  const webhookRows = await client.query(`SELECT id FROM whatsapp_messages WHERE meta_message_id=$1`, [metaMessageId]);
  const outboxRows = await client.query(`SELECT id FROM message_outbox WHERE dedupe_key=$1`, [`inbound:${metaMessageId}`]);
  assert.equal(webhookRows.rowCount, 1, 'Duplicate webhook should persist one inbound message.');
  assert.equal(outboxRows.rowCount, 1, 'Duplicate webhook should enqueue one bot job.');

  console.log('HTTP smoke checks passed: intake auth/validation/idempotency, exact consent proxy, CSRF/RBAC including staff management, security headers, Anjoora proxy, WhatsApp deduplication, and failure callbacks.');
} finally {
  if (clientConnected) {
    try {
      await client.query(`DELETE FROM message_outbox WHERE dedupe_key=ANY($1::text[])`, [[`inbound:${metaMessageId}`, statusOutboxKey]]);
      const ids = (await client.query(`SELECT c.id FROM consultations c JOIN customers cu ON cu.id=c.customer_id WHERE cu.phone=ANY($1::text[])`, [[directPhone, frontendPhone]])).rows.map((row) => row.id);
      const allEntityIds = [...new Set([...consultationEntityIds, ...ids])];
      if (allEntityIds.length) await client.query(`DELETE FROM audit_events WHERE entity_id=ANY($1::uuid[])`, [allEntityIds]);
      if (createdRecommendationId) await client.query(`DELETE FROM recommendations WHERE id=$1`, [createdRecommendationId]);
      if (createdFormulaId) await client.query(`DELETE FROM formulas WHERE id=$1`, [createdFormulaId]);
      await client.query(`DELETE FROM audit_events WHERE correlation_id=ANY($1::text[]) OR entity_id=$2 OR staff_user_id=$2`, [[directRequestId, invalidRequestId, rbacRequestId], supportStaffId]);
      if (managedSupportId) {
        await client.query(`DELETE FROM audit_events WHERE entity_id=$1 OR staff_user_id=ANY($2::uuid[])`, [managedSupportId, [managedSupportId, adminStaffId]]);
        await client.query(`DELETE FROM staff_users WHERE id=$1`, [managedSupportId]);
      }
      await client.query(`DELETE FROM audit_events WHERE entity_id=$1 OR staff_user_id=$1`, [adminStaffId]);
      await client.query(`DELETE FROM staff_users WHERE id=$1`, [adminStaffId]);
      await client.query(`DELETE FROM staff_users WHERE id=$1`, [supportStaffId]);
      if (allEntityIds.length) await client.query(`DELETE FROM consultations WHERE id=ANY($1::uuid[])`, [allEntityIds]);
      await client.query(`DELETE FROM customers WHERE phone=ANY($1::text[])`, [[directPhone, frontendPhone, webhookPhone]]);
      await client.query(`DELETE FROM formula_ingredients WHERE id=$1`, [catalogueIngredientId]);
      await client.query(`DELETE FROM inventory_items WHERE id=$1`, [catalogueInventoryId]);
      const rateLimitHashes = [
        rateLimitHash('consultation-ip', directIp),
        rateLimitHash('consultation-ip', invalidIp),
        rateLimitHash('consultation-ip', frontendIp),
        rateLimitHash('consultation-phone', directPhone),
        rateLimitHash('consultation-phone', frontendPhone),
        rateLimitHash('staff-login-ip', loginIp),
      ];
      await client.query(`DELETE FROM rate_limit_events WHERE key_hash=ANY($1::text[])`, [rateLimitHashes]);
    } finally {
      await client.end();
      clientConnected = false;
    }
  }
}
