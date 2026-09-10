import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { queueWhatsAppText, queueWhatsAppTemplate } from '@/lib/whatsapp';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, sameOriginRedirect } from '@/lib/http';
import { assertExpectedState, assertTransition, lockEntity } from '@/lib/transitions';

async function queueOrderNotice(db, order, { body, intent, templateName, parameters, dedupeKey }) {
  const recipient = (await db.query(`
    SELECT wc.id conversation_id,c.phone
    FROM orders o JOIN customers c ON c.id=o.customer_id
    LEFT JOIN whatsapp_conversations wc ON wc.customer_id=c.id
    WHERE o.id=$1
  `, [order.id])).rows[0];
  if (!recipient?.conversation_id) return false;
  if (templateName) {
    await queueWhatsAppTemplate({ db, conversationId: recipient.conversation_id, to: recipient.phone, templateName, parameters, intent, dedupeKey });
  } else {
    await queueWhatsAppText({ db, conversationId: recipient.conversation_id, to: recipient.phone, body, intent, dedupeKey });
  }
  return true;
}

function field(form, name, maximum, required = false) {
  const value = String(form.get(name) || '').trim();
  if (required && !value) throw new HttpError(422, `${name} is required.`, 'VALIDATION_ERROR');
  if (value.length > maximum) throw new HttpError(422, `${name} is too long.`, 'VALIDATION_ERROR');
  return value || null;
}

export async function POST(request) {
  let staff = null;
  let action = 'UNKNOWN';
  try {
    staff = await requireStaff({ request, capability: 'OPERATIONS' });
    const form = await request.formData();
    action = String(form.get('action') || '').trim().toLowerCase();
    if (!['create', 'ship', 'deliver'].includes(action)) {
      throw new HttpError(422, 'Unsupported dispatch action.', 'UNKNOWN_ACTION');
    }
    const orderId = String(form.get('order_id') || '');
    const expectedOrderStatus = String(form.get('expected_order_status') || '');
    if (!orderId) throw new HttpError(422, 'order_id is required.', 'VALIDATION_ERROR');

    await withTransaction(async (db) => {
      const order = await lockEntity(db, 'orders', orderId);
      let dispatch = (await db.query(`SELECT * FROM dispatches WHERE order_id=$1 FOR UPDATE`, [orderId])).rows[0];

      if (action === 'create') {
        if (dispatch) return;
        assertExpectedState(order, expectedOrderStatus);
        if (order.status !== 'READY_TO_DISPATCH') {
          throw new HttpError(409, 'Only a ready order can create a dispatch.', 'INVALID_ORDER_STATE');
        }
        dispatch = (await db.query(`
          INSERT INTO dispatches(id,public_id,order_id,courier,awb,shipping_address,status)
          VALUES($1,$2,$3,$4,$5,$6,'READY_FOR_DISPATCH') RETURNING *
        `, [uuid(), publicId('ANJ-DSP'), orderId, field(form, 'courier', 120), field(form, 'awb', 120), order.shipping_address])).rows[0];
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'DISPATCH', entityId: dispatch.id,
          action: 'CREATED', resultingState: dispatch.status, payload: { order_id: orderId },
        });
        return;
      }

      if (action === 'ship') {
        if (order.status === 'SHIPPED' && dispatch?.status === 'DISPATCHED') return;
        assertExpectedState(order, expectedOrderStatus);
        assertTransition('orders', order.status, 'SHIPPED');
        const expectedDispatchStatus = String(form.get('expected_dispatch_status') || '');
        const courier = field(form, 'courier', 120, true);
        const awb = field(form, 'awb', 120, true);
        if (!dispatch) {
          if (expectedDispatchStatus !== 'NONE') {
            throw new HttpError(409, 'Dispatch state changed; refresh and retry.', 'STALE_STATE');
          }
          dispatch = (await db.query(`
            INSERT INTO dispatches(id,public_id,order_id,courier,awb,shipping_address,status)
            VALUES($1,$2,$3,$4,$5,$6,'READY_FOR_DISPATCH') RETURNING *
          `, [uuid(), publicId('ANJ-DSP'), orderId, courier, awb, order.shipping_address])).rows[0];
        } else {
          assertExpectedState(dispatch, expectedDispatchStatus);
        }
        assertTransition('dispatches', dispatch.status, 'DISPATCHED');
        await db.query(`
          UPDATE dispatches SET courier=$1,awb=$2,status='DISPATCHED',dispatched_at=COALESCE(dispatched_at,now()),updated_at=now()
          WHERE id=$3
        `, [courier, awb, dispatch.id]);
        await db.query(`UPDATE orders SET status='SHIPPED',updated_at=now() WHERE id=$1`, [orderId]);
        const queued = await queueOrderNotice(db, order, {
          intent: 'DISPATCH_UPDATE', dedupeKey: `order:${orderId}:dispatched`,
          templateName: process.env.WHATSAPP_TEMPLATE_DISPATCH || null,
          parameters: [order.public_id, courier, awb],
          body: `Your ANJOORA order ${order.public_id} has been dispatched. Tracking/AWB: ${awb} (${courier}).`,
        });
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'DISPATCH', entityId: dispatch.id,
          action: 'DISPATCHED', priorState: dispatch.status, resultingState: 'DISPATCHED',
          payload: { order_id: orderId, courier, awb, message_queued: queued },
        });
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'ORDER', entityId: orderId,
          action: 'SHIPPED', priorState: order.status, resultingState: 'SHIPPED',
          payload: { dispatch_id: dispatch.id },
        });
        return;
      }

      if (order.status === 'DELIVERED' && dispatch?.status === 'DELIVERED') return;
      assertExpectedState(order, expectedOrderStatus);
      assertTransition('orders', order.status, 'DELIVERED');
      if (!dispatch) throw new HttpError(409, 'Delivery requires a dispatch record.', 'DISPATCH_REQUIRED');
      const expectedDispatchStatus = String(form.get('expected_dispatch_status') || '');
      assertExpectedState(dispatch, expectedDispatchStatus);
      assertTransition('dispatches', dispatch.status, 'DELIVERED');
      await db.query(`UPDATE dispatches SET status='DELIVERED',delivered_at=COALESCE(delivered_at,now()),updated_at=now() WHERE id=$1`, [dispatch.id]);
      await db.query(`UPDATE orders SET status='DELIVERED',updated_at=now() WHERE id=$1`, [orderId]);

      const planDays = Math.max(1, Number(order.expected_duration_days || 30));
      const refill = (await db.query(`
        INSERT INTO refills(id,public_id,customer_id,source_order_id,due_date,status)
        VALUES($1,$2,$3,$4,current_date+($5 * interval '1 day'),'NOT_DUE')
        ON CONFLICT(source_order_id) DO NOTHING
        RETURNING *
      `, [uuid(), publicId('ANJ-REF'), order.customer_id, orderId, planDays])).rows[0]
        || (await db.query(`SELECT * FROM refills WHERE source_order_id=$1`, [orderId])).rows[0];
      const queued = await queueOrderNotice(db, order, {
        intent: 'DELIVERY_UPDATE', dedupeKey: `order:${orderId}:delivered`,
        templateName: process.env.WHATSAPP_TEMPLATE_DELIVERED || null,
        parameters: [order.public_id],
        body: `Your ANJOORA order ${order.public_id} has been marked delivered. We will time the refill check-in from this delivery.`,
      });
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'DISPATCH', entityId: dispatch.id,
        action: 'DELIVERED', priorState: dispatch.status, resultingState: 'DELIVERED',
        payload: { order_id: orderId, refill_id: refill.id, message_queued: queued },
      });
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'ORDER', entityId: orderId,
        action: 'DELIVERED', priorState: order.status, resultingState: 'DELIVERED',
        payload: { dispatch_id: dispatch.id, refill_id: refill.id },
      });
    });
    return sameOriginRedirect('/admin/dispatch');
  } catch (error) {
    if (staff) {
      await writeAudit({ query }, {
        request, staffId: staff.id, entityType: 'DISPATCH', action,
        outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' },
      }).catch(() => {});
    }
    return errorResponse(error);
  }
}
