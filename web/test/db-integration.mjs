import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import '../scripts/load-env.mjs';
import { REQUIRED_MIGRATIONS } from '../lib/migrations.js';

const { Client } = pg;
if (!process.env.DATABASE_URL) {
  if (process.env.CI) throw new Error('DATABASE_URL is required for integration tests in CI.');
  console.log('PostgreSQL integration tests skipped: DATABASE_URL is not set.');
  process.exit(0);
}

const databaseName = `anjoora_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
if (!/^anjoora_test_[a-z0-9_]+$/.test(databaseName)) throw new Error('Unsafe integration database name.');
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.pathname = '/postgres';
const testUrl = new URL(process.env.DATABASE_URL);
testUrl.pathname = `/${databaseName}`;
const ssl = process.env.DATABASE_SSL === 'true'
  ? { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : {}) }
  : undefined;
const admin = new Client({ connectionString: adminUrl.toString(), ssl });

function id() { return crypto.randomUUID(); }
function publicId(prefix) { return `${prefix}-TEST-${crypto.randomBytes(16).toString('hex').toUpperCase()}`; }

await admin.connect();
try {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const db = new Client({ connectionString: testUrl.toString(), ssl });
  await db.connect();
  try {
    const migrationsDir = path.resolve('db/migrations');
    const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    assert.deepEqual(files, [...REQUIRED_MIGRATIONS]);
    await db.query(await fs.readFile(path.join(migrationsDir, files[0]), 'utf8'));

    const legacyStaffId = id();
    await db.query(`INSERT INTO staff_users(id,email,name,password_hash,role) VALUES($1,'legacy.staff@anjoora.in','Legacy Staff','legacy-hash','ADMIN')`, [legacyStaffId]);
    await db.query(`INSERT INTO sessions(id,staff_user_id,token_hash,expires_at) VALUES($1,$2,'legacy-session-token',now()+interval '1 hour')`, [id(), legacyStaffId]);
    const legacyCustomerId = id();
    const legacyConsultationId = id();
    await db.query(`INSERT INTO customers(id,public_id,name,phone) VALUES($1,$2,'Legacy Customer','919876543211')`, [legacyCustomerId, publicId('ANJ-C')]);
    await db.query(`
      INSERT INTO consultations(id,public_id,folio_id,customer_id,concern,folio_text,consent_at,status)
      VALUES($1,$2,$3,$4,'Sleep','legacy folio',now(),'SUBMITTED')
    `, [legacyConsultationId, publicId('ANJ-CON'), publicId('ANJ-FOL'), legacyCustomerId]);
    const legacyInventoryId = id();
    const legacyFormulaId = id();
    await db.query(`INSERT INTO inventory_items(id,public_id,sku,name,unit) VALUES($1,$2,'LEGACY-RM','Legacy material','g')`, [legacyInventoryId, publicId('ANJ-INV')]);
    await db.query(`INSERT INTO formulas(id,public_id,customer_id,consultation_id,name) VALUES($1,$2,$3,$4,'Legacy formula')`, [legacyFormulaId, publicId('ANJ-FRM'), legacyCustomerId, legacyConsultationId]);
    await db.query(`INSERT INTO formula_items(id,formula_id,inventory_item_id,ingredient_name,quantity,unit) VALUES($1,$2,$3,'Legacy material',1,'g')`, [id(), legacyFormulaId, legacyInventoryId]);
    for (const file of files.slice(1)) {
      await db.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
      if (file === '010_formula_ingredient_catalog.sql') {
        await db.query(`UPDATE staff_users SET mfa_enabled=true,mfa_secret_encrypted='legacy-encrypted-secret' WHERE id=$1`, [legacyStaffId]);
        await db.query(`INSERT INTO sessions(id,staff_user_id,token_hash,expires_at) VALUES($1,$2,'pre-password-only-session',now()+interval '1 hour')`, [id(), legacyStaffId]);
      }
    }

    const revalidatedStaff = await db.query(`
      SELECT must_rotate_password,mfa_enabled,mfa_secret_encrypted
      FROM staff_users WHERE id=$1
    `, [legacyStaffId]);
    const revokedSessions = await db.query(`SELECT count(*)::int count FROM sessions WHERE staff_user_id=$1`, [legacyStaffId]);
    const credentialAudit = await db.query(`SELECT action FROM audit_events WHERE entity_id=$1 AND action='CREDENTIAL_REVALIDATION_REQUIRED'`, [legacyStaffId]);
    assert.equal(revalidatedStaff.rows[0].must_rotate_password, true);
    assert.equal(revalidatedStaff.rows[0].mfa_enabled, false);
    assert.equal(revalidatedStaff.rows[0].mfa_secret_encrypted, null);
    assert.equal(revokedSessions.rows[0].count, 0);
    assert.equal(credentialAudit.rowCount, 1);
    const passwordOnlyAudit = await db.query(`SELECT action FROM audit_events WHERE entity_id=$1 AND action='AUTHENTICATION_POLICY_CHANGED'`, [legacyStaffId]);
    assert.equal(passwordOnlyAudit.rowCount, 1);
    const legacyIngredientMapping = await db.query(`
      SELECT ingredient.inventory_item_id,item.formula_ingredient_id
      FROM formula_items item
      JOIN formula_ingredients ingredient ON ingredient.id=item.formula_ingredient_id
      WHERE item.formula_id=$1
    `, [legacyFormulaId]);
    assert.equal(legacyIngredientMapping.rowCount, 1);
    assert.equal(legacyIngredientMapping.rows[0].inventory_item_id, legacyInventoryId);
    assert.equal(legacyIngredientMapping.rows[0].formula_ingredient_id, legacyInventoryId);

    const jobRun = await db.query(`
      INSERT INTO operational_job_runs(id,job_name,status,completed_at,duration_ms)
      VALUES($1,'outbox','SUCCEEDED',now(),12) RETURNING job_name,status
    `, [id()]);
    assert.deepEqual(jobRun.rows[0], { job_name: 'outbox', status: 'SUCCEEDED' });
    await assert.rejects(
      db.query(`INSERT INTO operational_job_runs(id,job_name,status) VALUES($1,'unknown','RUNNING')`, [id()]),
      (error) => error.code === '23514',
    );

    const legacyConcern = await db.query(`SELECT concern_label,is_primary,position FROM consultation_concerns WHERE consultation_id=$1`, [legacyConsultationId]);
    const legacySafety = await db.query(`SELECT flag_code,severity FROM consultation_safety_flags WHERE consultation_id=$1`, [legacyConsultationId]);
    const legacyConsultation = await db.query(`SELECT safety_review_required,urgent_safety_flag FROM consultations WHERE id=$1`, [legacyConsultationId]);
    assert.deepEqual(legacyConcern.rows, [{ concern_label: 'Sleep', is_primary: true, position: 1 }]);
    assert.deepEqual(legacySafety.rows, [{ flag_code: 'not-provided', severity: 'REVIEW' }]);
    assert.equal(legacyConsultation.rows[0].safety_review_required, true);
    assert.equal(legacyConsultation.rows[0].urgent_safety_flag, false);

    const customerId = id();
    const consultationId = id();
    const reviewId = id();
    const formulaId = id();
    const recommendationId = id();
    const inventoryId = id();
    const formulaIngredientId = id();
    await db.query(`INSERT INTO customers(id,public_id,name,phone) VALUES($1,$2,'Integration Customer','919876543210')`, [customerId, publicId('ANJ-C')]);
    await db.query(`
      INSERT INTO consultations(
        id,public_id,folio_id,customer_id,concern,folio_text,consent_at,status,
        safety_review_required,urgent_safety_flag,submission_id,consent_version
      ) VALUES($1,$2,$3,$4,'Sleep','test',now(),'REVIEWED',false,false,$5,'test-v1')
    `, [consultationId, publicId('ANJ-CON'), publicId('ANJ-FOL'), customerId, id()]);
    await db.query(`INSERT INTO review_cases(id,public_id,consultation_id,status) VALUES($1,$2,$3,'APPROVED')`, [reviewId, publicId('ANJ-CASE'), consultationId]);
    await db.query(`INSERT INTO inventory_items(id,public_id,sku,name,unit,reorder_level) VALUES($1,$2,'TEST-RM','Test material','g',0)`, [inventoryId, publicId('ANJ-INV')]);
    await db.query(`INSERT INTO formula_ingredients(id,public_id,inventory_item_id,name) VALUES($1,$2,$3,'Test material')`, [formulaIngredientId, publicId('ANJ-FING'), inventoryId]);
    await db.query(`INSERT INTO inventory_transactions(id,inventory_item_id,transaction_type,quantity,reference) VALUES($1,$2,'RECEIPT',10,'TEST')`, [id(), inventoryId]);
    await db.query(`INSERT INTO formulas(id,public_id,version,customer_id,consultation_id,name,status) VALUES($1,$2,1,$3,$4,'Test formula','APPROVED')`, [formulaId, publicId('ANJ-FRM'), customerId, consultationId]);
    await db.query(`INSERT INTO formula_items(id,formula_id,formula_ingredient_id,inventory_item_id,ingredient_name,quantity,unit) VALUES($1,$2,$3,$4,'Test material',7,'g')`, [id(), formulaId, formulaIngredientId, inventoryId]);
    await db.query(`
      INSERT INTO recommendations(id,public_id,consultation_id,review_case_id,summary,fulfillment_type,formula_id,duration_days,status,is_current)
      VALUES($1,$2,$3,$4,'Test','PERSONALISED',$5,30,'APPROVED',true)
    `, [recommendationId, publicId('ANJ-REC'), consultationId, reviewId, formulaId]);

    const orderId = id();
    await db.query(`
      INSERT INTO orders(id,public_id,customer_id,consultation_id,recommendation_id,status,amount,subtotal,payment_status)
      VALUES($1,$2,$3,$4,$5,'PAID',100,100,'PAID')
    `, [orderId, publicId('ANJ-ORD'), customerId, consultationId, recommendationId]);
    await assert.rejects(
      db.query(`INSERT INTO orders(id,public_id,customer_id,consultation_id,recommendation_id,status,amount,subtotal,payment_status) VALUES($1,$2,$3,$4,$5,'PAID',100,100,'PAID')`, [id(), publicId('ANJ-ORD'), customerId, consultationId, recommendationId]),
      (error) => error.code === '23505',
    );
    await assert.rejects(
      db.query(`UPDATE orders SET status='IN_PRODUCTION',payment_status='FAILED' WHERE id=$1`, [orderId]),
      (error) => error.code === '23514',
    );

    const paymentIntentId = id();
    await db.query(`
      INSERT INTO payment_intents(id,public_id,order_id,idempotency_key,provider,status,amount,currency)
      VALUES($1,$2,$3,$4,'TESTPAY','PAID',100,'INR')
    `, [paymentIntentId, publicId('ANJ-PAY'), orderId, `integration:${orderId}`]);
    await db.query(`
      INSERT INTO payment_events(
        id,provider,provider_event_id,payment_intent_id,order_id,event_type,canonical_status,payload
      ) VALUES($1,'TESTPAY','evt-duplicate',$2,$3,'payment.captured','PAID','{}'::jsonb)
    `, [id(), paymentIntentId, orderId]);
    await assert.rejects(
      db.query(`INSERT INTO payment_events(id,provider,provider_event_id,event_type,payload) VALUES($1,'TESTPAY','evt-duplicate','payment.captured','{}'::jsonb)`, [id()]),
      (error) => error.code === '23505',
    );

    const batchId = id();
    await db.query(`INSERT INTO batches(id,public_id,order_id,formula_id,status,production_quantity,wastage_percent) VALUES($1,$2,$3,$4,'PENDING',1,0)`, [batchId, publicId('ANJ-BAT'), orderId, formulaId]);
    await assert.rejects(
      db.query(`INSERT INTO batches(id,public_id,order_id,formula_id,status,production_quantity,wastage_percent) VALUES($1,$2,$3,$4,'PENDING',1,0)`, [id(), publicId('ANJ-BAT'), orderId, formulaId]),
      (error) => error.code === '23505',
    );
    await assert.rejects(
      db.query(`INSERT INTO formula_items(id,formula_id,formula_ingredient_id,inventory_item_id,ingredient_name,quantity,unit) VALUES($1,$2,$3,NULL,'Unmapped',1,'g')`, [id(), formulaId, formulaIngredientId]),
      (error) => error.code === '23502',
    );
    await assert.rejects(
      db.query(`UPDATE inventory_transactions SET quantity=11 WHERE inventory_item_id=$1`, [inventoryId]),
      (error) => error.code === '55000',
    );

    const makeConsumer = async (reference) => {
      const client = new Client({ connectionString: testUrl.toString(), ssl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO inventory_transactions(id,inventory_item_id,transaction_type,quantity,reference) VALUES($1,$2,'ADJUSTMENT',-7,$3)`, [id(), inventoryId, reference]);
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23514') return false;
        throw error;
      } finally { await client.end(); }
    };
    const concurrent = await Promise.all([makeConsumer('CONCURRENT-A'), makeConsumer('CONCURRENT-B')]);
    assert.equal(concurrent.filter(Boolean).length, 1, 'exactly one concurrent stock issue must succeed');
    const stock = await db.query(`SELECT available_quantity FROM inventory_stock WHERE id=$1`, [inventoryId]);
    assert.equal(Number(stock.rows[0].available_quantity), 3);

    const conversationId = id();
    await db.query(`INSERT INTO whatsapp_conversations(id,public_id,customer_id) VALUES($1,$2,$3)`, [conversationId, publicId('ANJ-WA'), customerId]);
    await db.query(`INSERT INTO whatsapp_messages(id,conversation_id,meta_message_id,direction,processing_status) VALUES($1,$2,'meta-test-1','INBOUND','QUEUED')`, [id(), conversationId]);
    await assert.rejects(
      db.query(`INSERT INTO whatsapp_messages(id,conversation_id,meta_message_id,direction,processing_status) VALUES($1,$2,'meta-test-1','INBOUND','QUEUED')`, [id(), conversationId]),
      (error) => error.code === '23505',
    );
    await db.query(`INSERT INTO message_outbox(id,job_type,dedupe_key,payload) VALUES($1,'BOT_INBOUND','meta-test-1','{}')`, [id()]);
    await assert.rejects(
      db.query(`INSERT INTO message_outbox(id,job_type,dedupe_key,payload) VALUES($1,'BOT_INBOUND','meta-test-1','{}')`, [id()]),
      (error) => error.code === '23505',
    );

    await assert.rejects(
      db.query(`UPDATE orders SET status='SHIPPED' WHERE id=$1`, [orderId]).then(async () => db.query(`UPDATE orders SET status='NOT_A_STATE' WHERE id=$1`, [orderId])),
      (error) => error.code === '23514',
    );
    console.log('PostgreSQL integration tests passed: migrations, uniqueness, mapping, immutable ledger, and concurrent stock protection.');
  } finally {
    await db.end();
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
}
