import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { randomToken, tokenHash } from '@/lib/security';
import { queueWhatsAppText } from '@/lib/whatsapp';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, hashPrivateValue, sameOriginRedirect } from '@/lib/http';
import { assertExpectedState, assertTransition, lockEntity } from '@/lib/transitions';

function money(value, field, { required = false } = {}) {
  if ((value === null || value === undefined || value === '') && !required) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100_000_000) {
    throw new HttpError(422, `${field} must be a valid non-negative amount.`, 'INVALID_AMOUNT');
  }
  return Number(number.toFixed(2));
}

function acceptanceUrl(token) {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) return null;
  try { return new URL(`/accept/order/${encodeURIComponent(token)}`, configured).toString(); } catch { return null; }
}

export async function POST(request) {
  let staff = null;
  let action = 'UNKNOWN';
  try {
    staff = await requireStaff({ request, capability: 'OPERATIONS' });
    const form = await request.formData();
    action = String(form.get('action') || 'create').trim().toLowerCase();
    if (!['create', 'ready', 'mark_paid', 'review_payment_event'].includes(action)) {
      throw new HttpError(422, 'Unsupported order action.', 'UNKNOWN_ACTION');
    }

    if (action === 'review_payment_event') {
      if (staff.role !== 'ADMIN') throw new HttpError(403, 'Only an administrator can resolve a payment event review.', 'FORBIDDEN');
      const eventId = String(form.get('payment_event_id') || '');
      const note = String(form.get('review_note') || '').trim();
      if (!eventId || note.length < 5 || note.length > 500) {
        throw new HttpError(422, 'Payment event and a 5-500 character review note are required.', 'VALIDATION_ERROR');
      }
      await withTransaction(async (db) => {
        const event = (await db.query(`SELECT * FROM payment_events WHERE id=$1 FOR UPDATE`, [eventId])).rows[0];
        if (!event) throw new HttpError(404, 'Payment event not found.', 'NOT_FOUND');
        if (event.processing_outcome !== 'REVIEW_REQUIRED') throw new HttpError(409, 'Payment event does not require review.', 'INVALID_STATE');
        if (event.reviewed_at) return;
        await db.query(`
          UPDATE payment_events SET reviewed_at=now(),reviewed_by=$1,review_note=$2 WHERE id=$3
        `, [staff.id, note, eventId]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'ORDER', entityId: event.order_id,
          action: 'PAYMENT_EVENT_REVIEWED', payload: {
            payment_event_id: event.id, canonical_status: event.canonical_status,
            review_note: note,
          },
        });
      });
      return sameOriginRedirect('/admin/orders');
    }

    if (action === 'mark_paid') {
      if (staff.role !== 'ADMIN') throw new HttpError(403, 'Only an administrator can reconcile a manual payment.', 'FORBIDDEN');
      const orderId = String(form.get('order_id') || '');
      const expectedStatus = String(form.get('expected_status') || '');
      const reference = String(form.get('payment_reference') || '').trim();
      if (!orderId || !reference || reference.length > 200) throw new HttpError(422, 'Order and payment reference are required.', 'VALIDATION_ERROR');
      await withTransaction(async (db) => {
        const order = await lockEntity(db, 'orders', orderId);
        if (order.status === 'PAID' && order.payment_status === 'PAID') return;
        assertExpectedState(order, expectedStatus);
        assertTransition('orders', order.status, 'PAID');
        const intentId = uuid();
        const intent = (await db.query(`
          INSERT INTO payment_intents(
            id,public_id,order_id,idempotency_key,provider,provider_reference,status,
            amount,currency,created_by,paid_at
          ) VALUES($1,$2,$3,$4,'MANUAL',$5,'PAID',$6,$7,$8,now())
          ON CONFLICT(idempotency_key) DO NOTHING RETURNING *
        `, [intentId, publicId('ANJ-PAY'), orderId, `manual:${orderId}:${reference}`, reference, order.amount, order.currency, staff.id])).rows[0]
          || (await db.query(`SELECT * FROM payment_intents WHERE idempotency_key=$1`, [`manual:${orderId}:${reference}`])).rows[0];
        await db.query(`
          INSERT INTO payment_events(id,provider,provider_event_id,payment_intent_id,order_id,event_type,payload)
          VALUES($1,'MANUAL',$2,$3,$4,'PAID',$5::jsonb)
          ON CONFLICT(provider,provider_event_id) DO NOTHING
        `, [uuid(), `manual:${orderId}:${reference}`, intent.id, orderId, JSON.stringify({ reference })]);
        await db.query(`UPDATE orders SET status='PAID',payment_status='PAID',updated_at=now() WHERE id=$1`, [orderId]);
        await db.query(`
          UPDATE payment_events
          SET reviewed_at=COALESCE(reviewed_at,now()),reviewed_by=COALESCE(reviewed_by,$1),
              review_note=COALESCE(review_note,'Resolved by independently verified manual reconciliation')
          WHERE order_id=$2 AND processing_outcome='REVIEW_REQUIRED' AND reviewed_at IS NULL
        `, [staff.id, orderId]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'ORDER', entityId: orderId,
          action: 'PAYMENT_MANUALLY_RECONCILED', priorState: order.status, resultingState: 'PAID',
          payload: { payment_intent_id: intent.id, reference_hash: hashPrivateValue(reference) },
        });
      });
      return sameOriginRedirect('/admin/orders');
    }

    if (action === 'ready') {
      const orderId = String(form.get('order_id') || '');
      const expectedStatus = String(form.get('expected_status') || '');
      if (!orderId) throw new HttpError(422, 'order_id is required.', 'VALIDATION_ERROR');
      await withTransaction(async (db) => {
        const order = await lockEntity(db, 'orders', orderId);
        if (order.status === 'READY_TO_DISPATCH') return;
        assertExpectedState(order, expectedStatus);
        assertTransition('orders', order.status, 'READY_TO_DISPATCH');
        const item = (await db.query(`
          SELECT oi.quantity order_quantity,p.id product_id,p.name,p.inventory_item_id,p.inventory_quantity,
                 ii.sku inventory_sku,ii.unit inventory_unit,ii.active inventory_active
          FROM order_items oi
          JOIN products p ON p.id=oi.product_id
          LEFT JOIN inventory_items ii ON ii.id=p.inventory_item_id
          WHERE oi.order_id=$1 AND oi.product_id IS NOT NULL
          LIMIT 1
        `, [orderId])).rows[0];
        if (!item) throw new HttpError(409, 'Only standard-product orders use this ready action.', 'INVALID_FULFILLMENT');
        if (!item.inventory_item_id || !item.inventory_quantity || !item.inventory_active) {
          throw new HttpError(409, 'Product is not mapped to active finished-goods inventory.', 'UNMAPPED_PRODUCT_STOCK');
        }
        await db.query(`SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE`, [item.inventory_item_id]);
        const required = Number(item.inventory_quantity) * Number(item.order_quantity);
        const available = Number((await db.query(`
          SELECT COALESCE(SUM(quantity),0)::numeric available
          FROM inventory_transactions WHERE inventory_item_id=$1
        `, [item.inventory_item_id])).rows[0].available);
        if (available < required) {
          throw new HttpError(409, `Insufficient finished stock for ${item.name}.`, 'INSUFFICIENT_STOCK');
        }
        const transactionId = uuid();
        await db.query(`
          INSERT INTO inventory_transactions(
            id,inventory_item_id,order_id,transaction_type,quantity,reference,note,created_by
          ) VALUES($1,$2,$3,'ORDER_ISSUE',$4,$5,'Allocated to standard-product order',$6)
        `, [transactionId, item.inventory_item_id, orderId, -required, order.public_id, staff.id]);
        await db.query(`UPDATE orders SET status='READY_TO_DISPATCH',updated_at=now() WHERE id=$1`, [orderId]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'INVENTORY_TRANSACTION', entityId: transactionId,
          action: 'ORDER_ISSUE', payload: {
            order_id: orderId, inventory_item_id: item.inventory_item_id,
            quantity: -required, unit: item.inventory_unit,
          },
        });
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'ORDER', entityId: orderId,
          action: 'READY_FOR_DISPATCH', priorState: order.status, resultingState: 'READY_TO_DISPATCH',
          payload: { inventory_transaction_id: transactionId },
        });
      });
      return sameOriginRedirect('/admin/orders');
    }

    const recommendationId = String(form.get('recommendation_id') || '');
    if (!recommendationId) throw new HttpError(422, 'recommendation_id is required.', 'VALIDATION_ERROR');
    const subtotal = money(form.get('subtotal') ?? form.get('amount'), 'Subtotal', { required: true });
    const discount = money(form.get('discount_amount'), 'Discount');
    const tax = money(form.get('tax_amount'), 'Tax');
    const shipping = money(form.get('shipping_amount'), 'Shipping');
    if (discount > subtotal) throw new HttpError(422, 'Discount cannot exceed subtotal.', 'INVALID_AMOUNT');
    const total = Number((subtotal - discount + tax + shipping).toFixed(2));
    if (total <= 0) throw new HttpError(422, 'Order total must be greater than zero.', 'INVALID_AMOUNT');
    const shippingAddress = String(form.get('shipping_address') || '').trim();
    if (shippingAddress.length > 500) throw new HttpError(422, 'Shipping address is too long.', 'VALIDATION_ERROR');

    const result = await withTransaction(async (db) => {
      const rec = (await db.query(`
        SELECT r.*,c.customer_id,c.urgent_safety_flag,cu.phone,cu.name customer_name,
               wc.id conversation_id
        FROM recommendations r
        JOIN consultations c ON c.id=r.consultation_id
        JOIN customers cu ON cu.id=c.customer_id
        LEFT JOIN whatsapp_conversations wc ON wc.customer_id=cu.id
        WHERE r.id=$1 FOR UPDATE OF r
      `, [recommendationId])).rows[0];
      if (!rec) throw new HttpError(404, 'Recommendation not found.', 'NOT_FOUND');
      const existing = (await db.query(`
        SELECT * FROM orders WHERE recommendation_id=$1 AND source_refill_id IS NULL FOR UPDATE
      `, [recommendationId])).rows[0];
      if (existing) return { order: existing, repeated: true };
      if (rec.status !== 'APPROVED' || !rec.is_current) {
        throw new HttpError(409, 'Only the current approved recommendation can become an order.', 'RECOMMENDATION_NOT_CURRENT');
      }
      if (rec.urgent_safety_flag) throw new HttpError(409, 'Urgent safety review blocks order creation.', 'SAFETY_BLOCK');

      let description;
      if (rec.fulfillment_type === 'STANDARD') {
        const product = (await db.query(`SELECT name,active FROM products WHERE id=$1`, [rec.product_id])).rows[0];
        if (!product?.active) throw new HttpError(409, 'The selected product is unavailable.', 'PRODUCT_UNAVAILABLE');
        description = product.name;
      } else if (rec.fulfillment_type === 'PERSONALISED') {
        const formula = (await db.query(`SELECT name,status FROM formulas WHERE id=$1`, [rec.formula_id])).rows[0];
        if (!formula || formula.status !== 'APPROVED') throw new HttpError(409, 'The formula is not approved.', 'FORMULA_UNAVAILABLE');
        description = formula.name;
      } else {
        throw new HttpError(409, 'Recommendation fulfillment is invalid.', 'INVALID_FULFILLMENT');
      }

      const id = uuid();
      const publicIdentifier = publicId('ANJ-ORD');
      const acceptanceToken = randomToken();
      const order = (await db.query(`
        INSERT INTO orders(
          id,public_id,customer_id,consultation_id,recommendation_id,status,amount,currency,
          expected_duration_days,shipping_address,acceptance_nonce,subtotal,discount_amount,
          tax_amount,shipping_amount,payment_status
        ) VALUES($1,$2,$3,$4,$5,'AWAITING_ACCEPTANCE',$6,'INR',$7,$8,$9,$10,$11,$12,$13,'NOT_STARTED')
        RETURNING *
      `, [
        id, publicIdentifier, rec.customer_id, rec.consultation_id, recommendationId, total,
        rec.duration_days, shippingAddress || null, tokenHash(acceptanceToken), subtotal, discount, tax, shipping,
      ])).rows[0];
      await db.query(`
        INSERT INTO order_items(id,order_id,product_id,formula_id,description,quantity,unit)
        VALUES($1,$2,$3,$4,$5,1,'unit')
      `, [uuid(), id, rec.product_id, rec.formula_id, description]);
      await db.query(`UPDATE whatsapp_conversations SET active_order_id=$1,updated_at=now() WHERE customer_id=$2`, [id, rec.customer_id]);
      const url = acceptanceUrl(acceptanceToken);
      if (rec.conversation_id && url) {
        await queueWhatsAppText({
          db, conversationId: rec.conversation_id, to: rec.phone, intent: 'ORDER_ACCEPTANCE',
          dedupeKey: `order:${id}:acceptance`,
          body: `Your ANJOORA recommendation is ready. Review and accept order ${publicIdentifier} here: ${url}`,
        });
      }
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'ORDER', entityId: id,
        action: 'CREATED', priorState: null, resultingState: 'AWAITING_ACCEPTANCE',
        payload: { recommendation_id: recommendationId, subtotal, discount, tax, shipping, total, acceptance_message_queued: Boolean(rec.conversation_id && url) },
      });
      return { order, repeated: false };
    });
    return sameOriginRedirect(`/admin/orders?created=${encodeURIComponent(result.order.public_id)}`);
  } catch (error) {
    if (staff) {
      await writeAudit({ query }, {
        request, staffId: staff.id, entityType: 'ORDER', action,
        outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' },
      }).catch(() => {});
    }
    if (error?.code === '23505') return errorResponse(new HttpError(409, 'An order already exists for this source.', 'DUPLICATE_ORDER'));
    if (error?.code === '23514') return errorResponse(new HttpError(409, 'Order or inventory constraints rejected this action.', 'CONSTRAINT_REJECTED'));
    return errorResponse(error);
  }
}
