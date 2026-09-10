import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, sameOriginRedirect } from '@/lib/http';

const TYPES = new Set(['ACCESS', 'CORRECTION', 'ANONYMIZATION']);

export async function POST(request) {
  let staff = null;
  let action = 'UNKNOWN';
  try {
    staff = await requireStaff({ request, capability: 'PRIVACY' });
    const form = await request.formData();
    action = String(form.get('action') || '').toLowerCase();
    if (!['create', 'complete', 'legal_hold'].includes(action)) throw new HttpError(422, 'Unsupported privacy action.', 'UNKNOWN_ACTION');
    if (action === 'legal_hold') {
      const reference = String(form.get('customer_ref') || '').trim();
      const holdValue = String(form.get('hold') || '').toLowerCase();
      const expectedValue = String(form.get('expected_legal_hold') || '').toLowerCase();
      const reason = String(form.get('reason') || '').trim();
      if (!reference || !['true', 'false'].includes(expectedValue) || !['yes', 'no'].includes(holdValue) || !reason || reason.length > 500) {
        throw new HttpError(422, 'Customer, expected hold state, desired hold state, and a reason are required.', 'VALIDATION_ERROR');
      }
      await withTransaction(async (db) => {
        const customer = (await db.query(`SELECT * FROM customers WHERE id::text=$1 OR public_id=$1 OR phone=$1 LIMIT 1 FOR UPDATE`, [reference])).rows[0];
        if (!customer) throw new HttpError(404, 'Customer not found.', 'NOT_FOUND');
        const expected = expectedValue === 'true';
        const desired = holdValue === 'yes';
        if (customer.legal_hold !== expected) throw new HttpError(409, 'Legal-hold state changed; refresh and retry.', 'STALE_STATE');
        if (customer.legal_hold === desired) return;
        await db.query(`UPDATE customers SET legal_hold=$1,updated_at=now() WHERE id=$2`, [desired, customer.id]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'CUSTOMER', entityId: customer.id,
          action: desired ? 'LEGAL_HOLD_APPLIED' : 'LEGAL_HOLD_RELEASED',
          priorState: String(customer.legal_hold), resultingState: String(desired),
          payload: { reason },
        });
      });
    } else if (action === 'create') {
      const reference = String(form.get('customer_ref') || '').trim();
      const requestType = String(form.get('request_type') || '').toUpperCase();
      const notes = String(form.get('notes') || '').trim().slice(0, 500) || null;
      if (!reference || !TYPES.has(requestType) || form.get('identity_verified') !== 'yes') {
        throw new HttpError(422, 'Customer, valid request type, and identity verification are required.', 'VALIDATION_ERROR');
      }
      await withTransaction(async (db) => {
        const customer = (await db.query(`SELECT * FROM customers WHERE public_id=$1 OR phone=$1 FOR UPDATE`, [reference])).rows[0];
        if (!customer) throw new HttpError(404, 'Customer not found.', 'NOT_FOUND');
        const record = (await db.query(`
          INSERT INTO data_subject_requests(
            id,public_id,customer_id,request_type,status,notes,verified_at,verification_evidence
          ) VALUES($1,$2,$3,$4,'OPEN',$5,now(),$6::jsonb) RETURNING *
        `, [uuid(), publicId('ANJ-DSR'), customer.id, requestType, notes, JSON.stringify({
          verified_by_staff_id: staff.id,
          method: process.env.PRIVACY_IDENTITY_VERIFICATION_METHOD || 'approved-manual-procedure',
          approval_id: process.env.PRIVACY_APPROVAL_ID || null,
        })])).rows[0];
        await db.query(`UPDATE customers SET identity_verified=true,updated_at=now() WHERE id=$1`, [customer.id]);
        await writeAudit(db, { request, staffId: staff.id, entityType: 'DATA_SUBJECT_REQUEST', entityId: record.id, action: 'CREATED', resultingState: 'OPEN', payload: { request_type: requestType, customer_id: customer.id } });
      });
    } else {
      const requestId = String(form.get('request_id') || '');
      const expectedStatus = String(form.get('expected_status') || '');
      if (!requestId || !expectedStatus) throw new HttpError(422, 'request_id and expected_status are required.', 'VALIDATION_ERROR');
      await withTransaction(async (db) => {
        const record = (await db.query(`SELECT * FROM data_subject_requests WHERE id=$1 FOR UPDATE`, [requestId])).rows[0];
        if (!record) throw new HttpError(404, 'Privacy request not found.', 'NOT_FOUND');
        if (record.status === 'COMPLETED') return;
        if (record.status !== expectedStatus) throw new HttpError(409, 'Privacy request state changed.', 'STALE_STATE');
        if (!record.verified_at) throw new HttpError(409, 'Identity verification is required.', 'IDENTITY_NOT_VERIFIED');
        const customer = (await db.query(`SELECT * FROM customers WHERE id=$1 FOR UPDATE`, [record.customer_id])).rows[0];
        if (!customer) throw new HttpError(404, 'Customer not found.', 'NOT_FOUND');
        if (record.request_type === 'CORRECTION') {
          const name = String(form.get('name') || '').trim();
          const city = String(form.get('city') || '').trim();
          const language = String(form.get('language') || '').trim();
          if (!name && !city && !language) throw new HttpError(422, 'At least one corrected field is required.', 'VALIDATION_ERROR');
          await db.query(`UPDATE customers SET name=COALESCE(NULLIF($1,''),name),city=COALESCE(NULLIF($2,''),city),language=COALESCE(NULLIF($3,''),language),updated_at=now() WHERE id=$4`, [name, city, language, customer.id]);
        } else if (record.request_type === 'ANONYMIZATION') {
          if (customer.legal_hold) throw new HttpError(409, 'Customer is under legal hold.', 'LEGAL_HOLD');
          const anonymousPhone = `anon-${customer.id.replaceAll('-', '')}`;
          await db.query(`
            DELETE FROM message_outbox
            WHERE payload->>'conversationId' IN (SELECT id::text FROM whatsapp_conversations WHERE customer_id=$1)
               OR payload->>'messageId' IN (
                 SELECT m.id::text FROM whatsapp_messages m
                 JOIN whatsapp_conversations wc ON wc.id=m.conversation_id WHERE wc.customer_id=$1
               )
          `, [customer.id]);
          await db.query(`DELETE FROM consultation_concerns WHERE consultation_id IN (SELECT id FROM consultations WHERE customer_id=$1)`, [customer.id]);
          await db.query(`DELETE FROM consultation_safety_flags WHERE consultation_id IN (SELECT id FROM consultations WHERE customer_id=$1)`, [customer.id]);
          await db.query(`UPDATE consultations SET concern='Anonymized',main_goal=NULL,duration=NULL,daily_effect=NULL,appetite_digestion=NULL,body_climate=NULL,energy_pattern=NULL,meal_rhythm=NULL,sleep_rhythm=NULL,realistic_rituals='[]'::jsonb,stress_response=NULL,emotional_support=NULL,change_style=NULL,preferred_format=NULL,raw_payload='{}'::jsonb,folio_text='[ANONYMIZED]',consent_text=NULL,submission_response=NULL,raw_payload_purged_at=now(),updated_at=now() WHERE customer_id=$1`, [customer.id]);
          await db.query(`UPDATE consultation_notes SET author_ref=NULL,body='[ANONYMIZED]' WHERE consultation_id IN (SELECT id FROM consultations WHERE customer_id=$1)`, [customer.id]);
          await db.query(`UPDATE review_cases SET clarification_question=NULL,updated_at=now() WHERE consultation_id IN (SELECT id FROM consultations WHERE customer_id=$1)`, [customer.id]);
          await db.query(`UPDATE recommendations SET summary='[ANONYMIZED]',usage_instructions=NULL,updated_at=now() WHERE consultation_id IN (SELECT id FROM consultations WHERE customer_id=$1)`, [customer.id]);
          await db.query(`UPDATE formulas SET name='Anonymized formula',instructions=NULL WHERE customer_id=$1`, [customer.id]);
          await db.query(`UPDATE whatsapp_messages SET meta_message_id=NULL,body=NULL,raw_payload='{}'::jsonb,raw_payload_purged_at=now(),updated_at=now() WHERE conversation_id IN (SELECT id FROM whatsapp_conversations WHERE customer_id=$1)`, [customer.id]);
          await db.query(`UPDATE whatsapp_conversations SET active_consultation_id=NULL,active_order_id=NULL,status='CLOSED',needs_human=false,assigned_to=NULL,updated_at=now() WHERE customer_id=$1`, [customer.id]);
          await db.query(`UPDATE orders SET shipping_address=NULL,acceptance_evidence='{}'::jsonb,updated_at=now() WHERE customer_id=$1`, [customer.id]);
          await db.query(`UPDATE dispatches SET shipping_address=NULL,awb=NULL,updated_at=now() WHERE order_id IN (SELECT id FROM orders WHERE customer_id=$1)`, [customer.id]);
          await db.query(`UPDATE payment_intents SET raw_payload='{}'::jsonb,payment_url=NULL,updated_at=now() WHERE order_id IN (SELECT id FROM orders WHERE customer_id=$1)`, [customer.id]);
          await db.query(`UPDATE payment_events SET payload='{}'::jsonb,raw_payload_purged_at=now() WHERE order_id IN (SELECT id FROM orders WHERE customer_id=$1)`, [customer.id]);
          await db.query(`UPDATE customers SET name='Anonymized Customer',phone=$1,city=NULL,language=NULL,best_contact_time=NULL,status='ANONYMIZED',identity_verified=false,anonymized_at=now(),updated_at=now() WHERE id=$2`, [anonymousPhone, customer.id]);
        }
        await db.query(`UPDATE data_subject_requests SET status='COMPLETED',completed_at=now(),handled_by=$1 WHERE id=$2`, [staff.id, requestId]);
        await writeAudit(db, { request, staffId: staff.id, entityType: 'DATA_SUBJECT_REQUEST', entityId: requestId, action: 'COMPLETED', priorState: record.status, resultingState: 'COMPLETED', payload: { request_type: record.request_type, customer_id: customer.id } });
      });
    }
    return sameOriginRedirect('/admin/privacy');
  } catch (error) {
    if (staff) await writeAudit({ query }, { request, staffId: staff.id, entityType: 'DATA_SUBJECT_REQUEST', action, outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' } }).catch(() => {});
    return errorResponse(error);
  }
}
