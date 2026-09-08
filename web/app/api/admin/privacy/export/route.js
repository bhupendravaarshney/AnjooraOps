import { requireStaff } from '@/lib/auth';
import { withTransaction } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse } from '@/lib/http';

export async function GET(request) {
  try {
    const staff = await requireStaff({ roles: ['ADMIN'] });
    const requestId = new URL(request.url).searchParams.get('request_id');
    if (!requestId) throw new HttpError(422, 'request_id is required.', 'VALIDATION_ERROR');

    const exported = await withTransaction(async (db) => {
      const record = (await db.query(`
        SELECT id,public_id,customer_id,request_type,status,requested_at,completed_at,verified_at
        FROM data_subject_requests
        WHERE id=$1 AND request_type='ACCESS' AND verified_at IS NOT NULL
      `, [requestId])).rows[0];
      if (!record) throw new HttpError(404, 'Verified access request not found.', 'NOT_FOUND');

      const customer = (await db.query(`
        SELECT public_id,name,phone,city,language,best_contact_time,status,created_at,updated_at,anonymized_at
        FROM customers WHERE id=$1
      `, [record.customer_id])).rows[0];
      if (!customer) throw new HttpError(404, 'Customer not found.', 'NOT_FOUND');

      const [consultations, concerns, safetyFlags, notes, recommendations, formulaItems, orders, orderItems, dispatches, paymentIntents, paymentEvents, refills, messages] = await Promise.all([
        db.query(`
          SELECT public_id,folio_id,concern,main_goal,duration,daily_effect,appetite_digestion,
                 body_climate,energy_pattern,meal_rhythm,sleep_rhythm,realistic_rituals,
                 stress_response,emotional_support,change_style,preferred_format,
                 questionnaire_version,consent_text,consent_at,consent_version,folio_text,status,
                 safety_review_required,urgent_safety_flag,safety_screen_version,
                 raw_payload_purged_at,created_at,updated_at
          FROM consultations WHERE customer_id=$1 ORDER BY created_at
        `, [record.customer_id]),
        db.query(`
          SELECT c.public_id consultation_id,cc.concern_key,cc.concern_label,cc.is_primary,cc.position,cc.created_at
          FROM consultation_concerns cc JOIN consultations c ON c.id=cc.consultation_id
          WHERE c.customer_id=$1 ORDER BY c.created_at,cc.position
        `, [record.customer_id]),
        db.query(`
          SELECT c.public_id consultation_id,sf.flag_code,sf.flag_label,sf.severity,sf.position,sf.created_at
          FROM consultation_safety_flags sf JOIN consultations c ON c.id=sf.consultation_id
          WHERE c.customer_id=$1 ORDER BY c.created_at,sf.position
        `, [record.customer_id]),
        db.query(`
          SELECT c.public_id consultation_id,n.author_type,n.note_type,n.body,n.created_at
          FROM consultation_notes n JOIN consultations c ON c.id=n.consultation_id
          WHERE c.customer_id=$1 ORDER BY n.created_at
        `, [record.customer_id]),
        db.query(`
          SELECT r.public_id,c.public_id consultation_id,r.summary,r.fulfillment_type,
                 p.sku product_sku,p.name product_name,f.public_id formula_id,f.version formula_version,
                 f.name formula_name,f.format formula_format,r.duration_days,r.usage_instructions,
                 r.status,r.is_current,r.created_at,r.updated_at
          FROM recommendations r
          JOIN consultations c ON c.id=r.consultation_id
          LEFT JOIN products p ON p.id=r.product_id
          LEFT JOIN formulas f ON f.id=r.formula_id
          WHERE c.customer_id=$1 ORDER BY r.created_at
        `, [record.customer_id]),
        db.query(`
          SELECT f.public_id formula_id,f.version,fi.ingredient_name,fi.quantity,fi.unit,fi.created_at
          FROM formula_items fi JOIN formulas f ON f.id=fi.formula_id
          WHERE f.customer_id=$1 ORDER BY f.created_at,fi.created_at
        `, [record.customer_id]),
        db.query(`
          SELECT o.public_id,r.public_id recommendation_id,sr.public_id source_refill_id,
                 o.status,o.payment_status,o.subtotal,o.discount_amount,o.tax_amount,
                 o.shipping_amount,o.amount,o.currency,o.expected_duration_days,o.shipping_address,
                 o.accepted_at,o.acceptance_channel,o.created_at,o.updated_at
          FROM orders o
          JOIN recommendations r ON r.id=o.recommendation_id
          LEFT JOIN refills sr ON sr.id=o.source_refill_id
          WHERE o.customer_id=$1 ORDER BY o.created_at
        `, [record.customer_id]),
        db.query(`
          SELECT o.public_id order_id,oi.description,oi.quantity,oi.unit,p.sku product_sku,
                 p.name product_name,f.public_id formula_id,f.version formula_version,oi.created_at
          FROM order_items oi JOIN orders o ON o.id=oi.order_id
          LEFT JOIN products p ON p.id=oi.product_id
          LEFT JOIN formulas f ON f.id=oi.formula_id
          WHERE o.customer_id=$1 ORDER BY o.created_at,oi.created_at
        `, [record.customer_id]),
        db.query(`
          SELECT d.public_id,o.public_id order_id,d.courier,d.awb,d.shipping_address,d.status,
                 d.dispatched_at,d.delivered_at,d.created_at,d.updated_at
          FROM dispatches d JOIN orders o ON o.id=d.order_id
          WHERE o.customer_id=$1 ORDER BY d.created_at
        `, [record.customer_id]),
        db.query(`
          SELECT pi.public_id,o.public_id order_id,pi.provider,pi.provider_reference,pi.status,
                 pi.amount,pi.currency,pi.created_at,pi.updated_at,pi.paid_at,pi.failed_at,
                 pi.cancelled_at,pi.refunded_at
          FROM payment_intents pi JOIN orders o ON o.id=pi.order_id
          WHERE o.customer_id=$1 ORDER BY pi.created_at
        `, [record.customer_id]),
        db.query(`
          SELECT o.public_id order_id,pe.provider,pe.event_type,pe.processed_at,pe.raw_payload_purged_at
          FROM payment_events pe JOIN orders o ON o.id=pe.order_id
          WHERE o.customer_id=$1 ORDER BY pe.processed_at
        `, [record.customer_id]),
        db.query(`
          SELECT rf.public_id,source.public_id source_order_id,next_order.public_id next_order_id,
                 rf.due_date,rf.status,rf.decision,rf.last_reminded_at,rf.last_reminder_type,
                 rf.created_at,rf.updated_at
          FROM refills rf
          JOIN orders source ON source.id=rf.source_order_id
          LEFT JOIN orders next_order ON next_order.id=rf.next_order_id
          WHERE rf.customer_id=$1 ORDER BY rf.created_at
        `, [record.customer_id]),
        db.query(`
          SELECT m.direction,m.message_type,m.body,m.intent,m.delivery_status,m.created_at,m.processed_at,
                 m.raw_payload_purged_at
          FROM whatsapp_messages m
          JOIN whatsapp_conversations wc ON wc.id=m.conversation_id
          WHERE wc.customer_id=$1 ORDER BY m.created_at
        `, [record.customer_id]),
      ]);

      await writeAudit(db, {
        request,
        staffId: staff.id,
        entityType: 'DATA_SUBJECT_REQUEST',
        entityId: record.id,
        action: 'ACCESS_EXPORT_DOWNLOADED',
        priorState: record.status,
        resultingState: record.status,
        payload: { customer_id: record.customer_id },
      });

      return {
        exported_at: new Date().toISOString(),
        request: {
          public_id: record.public_id,
          type: record.request_type,
          status: record.status,
          requested_at: record.requested_at,
          verified_at: record.verified_at,
          completed_at: record.completed_at,
        },
        customer,
        consultations: consultations.rows,
        consultation_concerns: concerns.rows,
        consultation_safety_flags: safetyFlags.rows,
        consultation_notes: notes.rows,
        recommendations: recommendations.rows,
        formula_items: formulaItems.rows,
        orders: orders.rows,
        order_items: orderItems.rows,
        dispatches: dispatches.rows,
        payment_intents: paymentIntents.rows,
        payment_events: paymentEvents.rows,
        refills: refills.rows,
        whatsapp_messages: messages.rows,
      };
    });

    const body = JSON.stringify(exported, null, 2);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exported.request.public_id}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
