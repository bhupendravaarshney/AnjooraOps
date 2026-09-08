import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { randomToken, tokenHash } from '@/lib/security';
import { queueWhatsAppText } from '@/lib/whatsapp';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse } from '@/lib/http';
import { assertExpectedState, assertTransition, lockEntity } from '@/lib/transitions';

const DECISIONS = new Set(['SAME', 'MODIFY', 'STOP']);

function acceptanceUrl(token) {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) return null;
  try { return new URL(`/accept/order/${encodeURIComponent(token)}`, configured).toString(); } catch { return null; }
}

export async function POST(request) {
  let staff = null;
  let decision = 'UNKNOWN';
  try {
    staff = await requireStaff({ request, roles: ['OPERATIONS'] });
    const form = await request.formData();
    const refillId = String(form.get('refill_id') || '');
    const expectedStatus = String(form.get('expected_status') || '');
    decision = String(form.get('decision') || '').trim().toUpperCase();
    if (!refillId) throw new HttpError(422, 'refill_id is required.', 'VALIDATION_ERROR');
    if (!DECISIONS.has(decision)) throw new HttpError(422, 'Unsupported refill decision.', 'UNKNOWN_ACTION');

    const result = await withTransaction(async (db) => {
      const refill = await lockEntity(db, 'refills', refillId);
      if (decision === 'SAME' && refill.status === 'ORDERED' && refill.next_order_id) {
        return { order: (await db.query(`SELECT * FROM orders WHERE id=$1`, [refill.next_order_id])).rows[0], repeated: true };
      }
      if (decision === 'MODIFY' && refill.status === 'REVIEW_PENDING' && refill.decision === 'MODIFY') {
        return { repeated: true };
      }
      if (decision === 'STOP' && refill.status === 'CLOSED' && refill.decision === 'STOP') {
        return { repeated: true };
      }
      if (['ORDERED', 'CLOSED'].includes(refill.status)) {
        throw new HttpError(409, `Refill already ended as ${refill.status}.`, 'TERMINAL_STATE');
      }
      assertExpectedState(refill, expectedStatus);
      const source = (await db.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [refill.source_order_id])).rows[0];
      if (!source) throw new HttpError(404, 'Source order not found.', 'NOT_FOUND');

      if (decision === 'SAME') {
        assertTransition('refills', refill.status, 'ORDERED');
        const existing = (await db.query(`SELECT * FROM orders WHERE source_refill_id=$1 FOR UPDATE`, [refillId])).rows[0];
        if (existing) {
          await db.query(`UPDATE refills SET decision='SAME',status='ORDERED',next_order_id=$1,updated_at=now() WHERE id=$2`, [existing.id, refillId]);
          return { order: existing, repeated: true };
        }
        const id = uuid();
        const publicIdentifier = publicId('ANJ-ORD');
        const acceptanceToken = randomToken();
        const order = (await db.query(`
          INSERT INTO orders(
            id,public_id,customer_id,consultation_id,recommendation_id,source_refill_id,status,
            amount,currency,expected_duration_days,shipping_address,acceptance_nonce,subtotal,
            discount_amount,tax_amount,shipping_amount,payment_status
          ) VALUES($1,$2,$3,$4,$5,$6,'AWAITING_ACCEPTANCE',$7,$8,$9,$10,$11,$12,$13,$14,$15,'NOT_STARTED')
          RETURNING *
        `, [
          id, publicIdentifier, source.customer_id, source.consultation_id, source.recommendation_id,
          refillId, source.amount, source.currency, source.expected_duration_days, source.shipping_address,
          tokenHash(acceptanceToken), source.subtotal, source.discount_amount, source.tax_amount, source.shipping_amount,
        ])).rows[0];
        const items = (await db.query(`
          SELECT product_id,formula_id,description,quantity,unit FROM order_items WHERE order_id=$1
        `, [source.id])).rows;
        for (const item of items) {
          await db.query(`
            INSERT INTO order_items(id,order_id,product_id,formula_id,description,quantity,unit)
            VALUES($1,$2,$3,$4,$5,$6,$7)
          `, [uuid(), id, item.product_id, item.formula_id, item.description, item.quantity, item.unit]);
        }
        await db.query(`UPDATE refills SET decision='SAME',status='ORDERED',next_order_id=$1,updated_at=now() WHERE id=$2`, [id, refillId]);
        const conversation = (await db.query(`
          UPDATE whatsapp_conversations SET active_order_id=$1,updated_at=now()
          WHERE customer_id=$2 RETURNING id
        `, [id, source.customer_id])).rows[0];
        const customer = (await db.query(`SELECT phone FROM customers WHERE id=$1`, [source.customer_id])).rows[0];
        const url = acceptanceUrl(acceptanceToken);
        if (conversation && customer && url) {
          await queueWhatsAppText({
            db, conversationId: conversation.id, to: customer.phone, intent: 'REFILL_ORDER_ACCEPTANCE',
            dedupeKey: `refill:${refillId}:order-acceptance`,
            body: `Your repeat ANJOORA order ${publicIdentifier} is ready to review and accept: ${url}`,
          });
        }
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'ORDER', entityId: id,
          action: 'CREATED_FROM_REFILL', resultingState: 'AWAITING_ACCEPTANCE',
          payload: { refill_id: refillId, source_order_id: source.id },
        });
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'REFILL', entityId: refillId,
          action: 'SAME', priorState: refill.status, resultingState: 'ORDERED',
          payload: { next_order_id: id },
        });
        return { order, repeated: false };
      }

      if (decision === 'MODIFY') {
        if (refill.status !== 'REVIEW_PENDING') assertTransition('refills', refill.status, 'REVIEW_PENDING');
        await db.query(`UPDATE refills SET decision='MODIFY',status='REVIEW_PENDING',updated_at=now() WHERE id=$1`, [refillId]);
        await db.query(`
          INSERT INTO consultation_notes(id,consultation_id,author_type,note_type,body)
          VALUES($1,$2,'SYSTEM','REFILL_MODIFICATION_REQUEST','A review was requested before the next refill cycle.')
        `, [uuid(), source.consultation_id]);
        await db.query(`UPDATE review_cases SET status='NEW',updated_at=now() WHERE consultation_id=$1`, [source.consultation_id]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'REFILL', entityId: refillId,
          action: 'MODIFY', priorState: refill.status, resultingState: 'REVIEW_PENDING',
          payload: { consultation_id: source.consultation_id },
        });
        return { repeated: false };
      }

      assertTransition('refills', refill.status, 'CLOSED');
      await db.query(`UPDATE refills SET decision='STOP',status='CLOSED',updated_at=now() WHERE id=$1`, [refillId]);
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'REFILL', entityId: refillId,
        action: 'STOP', priorState: refill.status, resultingState: 'CLOSED', payload: {},
      });
      return { repeated: false };
    });
    const suffix = result.order ? `?order=${encodeURIComponent(result.order.public_id)}` : '';
    return NextResponse.redirect(new URL(`/admin/refills${suffix}`, request.url), 303);
  } catch (error) {
    if (staff) {
      await writeAudit({ query }, {
        request, staffId: staff.id, entityType: 'REFILL', action: decision,
        outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' },
      }).catch(() => {});
    }
    if (error?.code === '23505') return errorResponse(new HttpError(409, 'This refill already has a next order.', 'DUPLICATE_ORDER'));
    return errorResponse(error);
  }
}
