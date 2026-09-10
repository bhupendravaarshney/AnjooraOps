import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, sameOriginRedirect } from '@/lib/http';
import { assertExpectedState, assertTransition, lockEntity } from '@/lib/transitions';
import { normalizeUnit, requireMatchingUnit } from '@/lib/units';

function positiveNumber(value, field, maximum = 1_000_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > maximum) {
    throw new HttpError(422, `${field} must be a positive number.`, 'INVALID_QUANTITY');
  }
  return number;
}

export async function POST(request) {
  let staff = null;
  let action = 'UNKNOWN';
  try {
    staff = await requireStaff({ request, capability: 'OPERATIONS' });
    const form = await request.formData();
    action = String(form.get('action') || '').trim().toLowerCase();
    if (!['create', 'complete'].includes(action)) {
      throw new HttpError(422, 'Unsupported batch action.', 'UNKNOWN_ACTION');
    }

    if (action === 'create') {
      const orderReference = String(form.get('order_ref') || form.get('order_id') || '').trim();
      const expectedStatus = String(form.get('expected_status') || '');
      const submittedProductionQuantity = form.get('production_quantity')
        ? positiveNumber(form.get('production_quantity'), 'Production quantity')
        : null;
      const wastagePercent = Number(form.get('wastage_percent') || 0);
      if (!orderReference || orderReference.length > 100) throw new HttpError(422, 'A valid order reference is required.', 'VALIDATION_ERROR');
      if (!Number.isFinite(wastagePercent) || wastagePercent < 0 || wastagePercent > 25) {
        throw new HttpError(422, 'Wastage must be between 0 and 25 percent.', 'INVALID_WASTAGE');
      }

      const result = await withTransaction(async (db) => {
        const resolvedOrder = (await db.query(`SELECT id FROM orders WHERE id::text=$1 OR public_id=$1 LIMIT 1`, [orderReference])).rows[0];
        if (!resolvedOrder) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
        const orderId = resolvedOrder.id;
        const order = await lockEntity(db, 'orders', orderId);
        const existing = (await db.query(`SELECT * FROM batches WHERE order_id=$1 FOR UPDATE`, [orderId])).rows[0];
        if (existing) return { batch: existing, repeated: true };
        assertExpectedState(order, expectedStatus);
        assertTransition('orders', order.status, 'IN_PRODUCTION');

        const recommendation = (await db.query(`
          SELECT r.formula_id,r.product_id,r.fulfillment_type
          FROM recommendations r WHERE r.id=$1
        `, [order.recommendation_id])).rows[0];
        if (!recommendation || recommendation.fulfillment_type !== 'PERSONALISED' || !recommendation.formula_id) {
          throw new HttpError(409, 'Only paid personalised orders can create a production batch.', 'BATCH_NOT_REQUIRED');
        }
        const orderedQuantity = Number((await db.query(`
          SELECT COALESCE(SUM(quantity),0)::numeric quantity
          FROM order_items WHERE order_id=$1 AND formula_id=$2
        `, [orderId, recommendation.formula_id])).rows[0].quantity);
        if (!Number.isFinite(orderedQuantity) || orderedQuantity <= 0) {
          throw new HttpError(409, 'The order has no valid personalised production quantity.', 'INVALID_ORDER_QUANTITY');
        }
        if (submittedProductionQuantity !== null && Math.abs(submittedProductionQuantity - orderedQuantity) > 0.0001) {
          throw new HttpError(422, 'Production quantity must match the personalised order quantity.', 'PRODUCTION_QUANTITY_MISMATCH');
        }
        const productionQuantity = orderedQuantity;
        const formulaItems = (await db.query(`
          SELECT fi.inventory_item_id,fi.ingredient_name,fi.quantity,fi.unit,
                 ii.unit inventory_unit,ii.active
          FROM formula_items fi
          LEFT JOIN inventory_items ii ON ii.id=fi.inventory_item_id
          WHERE fi.formula_id=$1
          ORDER BY fi.id
        `, [recommendation.formula_id])).rows;
        if (!formulaItems.length) {
          throw new HttpError(409, 'The personalised formula has no ingredients.', 'EMPTY_FORMULA');
        }
        for (const item of formulaItems) {
          if (!item.inventory_item_id || !item.inventory_unit || !item.active) {
            throw new HttpError(409, `Ingredient ${item.ingredient_name} is not mapped to an active inventory item.`, 'UNMAPPED_INGREDIENT');
          }
          requireMatchingUnit(item.inventory_unit, item.unit);
        }

        const batchId = uuid();
        const batch = (await db.query(`
          INSERT INTO batches(
            id,public_id,order_id,formula_id,product_id,status,planned_quantity,unit,
            production_quantity,wastage_percent
          ) VALUES($1,$2,$3,$4,NULL,'PENDING',$5,'unit',$5,$6)
          RETURNING *
        `, [batchId, publicId('ANJ-BAT'), orderId, recommendation.formula_id, productionQuantity, wastagePercent])).rows[0];
        const multiplier = productionQuantity * (1 + wastagePercent / 100);
        for (const item of formulaItems) {
          const unit = normalizeUnit(item.unit);
          const requiredQuantity = Number((Number(item.quantity) * multiplier).toFixed(3));
          if (requiredQuantity <= 0) throw new HttpError(422, 'Calculated ingredient quantity is invalid.', 'INVALID_QUANTITY');
          await db.query(`
            INSERT INTO batch_items(id,batch_id,inventory_item_id,quantity,unit)
            VALUES($1,$2,$3,$4,$5)
          `, [uuid(), batchId, item.inventory_item_id, requiredQuantity, unit]);
        }
        await db.query(`UPDATE orders SET status='IN_PRODUCTION',updated_at=now() WHERE id=$1`, [orderId]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'BATCH', entityId: batchId,
          action: 'CREATED', priorState: null, resultingState: 'PENDING',
          payload: { order_id: orderId, production_quantity: productionQuantity, wastage_percent: wastagePercent },
        });
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'ORDER', entityId: orderId,
          action: 'BATCH_STARTED', priorState: order.status, resultingState: 'IN_PRODUCTION',
          payload: { batch_id: batchId },
        });
        return { batch, repeated: false };
      });
      return sameOriginRedirect(`/admin/batches?batch=${encodeURIComponent(result.batch.public_id)}`);
    }

    const batchId = String(form.get('batch_id') || '');
    const expectedStatus = String(form.get('expected_status') || '');
    if (!batchId) throw new HttpError(422, 'batch_id is required.', 'VALIDATION_ERROR');
    await withTransaction(async (db) => {
      const batch = await lockEntity(db, 'batches', batchId);
      if (batch.status === 'READY_FOR_PACKING') return;
      assertExpectedState(batch, expectedStatus);
      assertTransition('batches', batch.status, 'READY_FOR_PACKING');
      const order = await lockEntity(db, 'orders', batch.order_id);
      if (order.status !== 'IN_PRODUCTION') {
        throw new HttpError(409, `Order must be IN_PRODUCTION, not ${order.status}.`, 'INVALID_ORDER_STATE');
      }
      assertTransition('orders', order.status, 'READY_TO_DISPATCH');

      const items = (await db.query(`
        SELECT bi.*,ii.sku,ii.name,ii.unit inventory_unit
        FROM batch_items bi JOIN inventory_items ii ON ii.id=bi.inventory_item_id
        WHERE bi.batch_id=$1 ORDER BY bi.inventory_item_id
      `, [batchId])).rows;
      if (!items.length) throw new HttpError(409, 'Batch has no material requirements.', 'EMPTY_BATCH');
      const inventoryIds = [...new Set(items.map((item) => item.inventory_item_id))];
      await db.query(`
        SELECT id FROM inventory_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE
      `, [inventoryIds]);
      const stockRows = (await db.query(`
        SELECT inventory_item_id,COALESCE(SUM(quantity),0)::numeric AS available
        FROM inventory_transactions WHERE inventory_item_id=ANY($1::uuid[])
        GROUP BY inventory_item_id
      `, [inventoryIds])).rows;
      const available = new Map(stockRows.map((row) => [row.inventory_item_id, Number(row.available)]));
      const required = new Map();
      for (const item of items) {
        requireMatchingUnit(item.inventory_unit, item.unit);
        required.set(item.inventory_item_id, (required.get(item.inventory_item_id) || 0) + Number(item.quantity));
      }
      for (const item of items) {
        const need = required.get(item.inventory_item_id);
        if ((available.get(item.inventory_item_id) || 0) < need) {
          throw new HttpError(409, `Insufficient stock for ${item.sku} (${item.name}).`, 'INSUFFICIENT_STOCK');
        }
      }
      for (const item of items) {
        const transactionId = uuid();
        await db.query(`
          INSERT INTO inventory_transactions(
            id,inventory_item_id,batch_id,transaction_type,quantity,reference,note,created_by
          ) VALUES($1,$2,$3,'BATCH_ISSUE',$4,$5,'Consumed by completed batch',$6)
        `, [transactionId, item.inventory_item_id, batchId, -Number(item.quantity), batch.public_id, staff.id]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'INVENTORY_TRANSACTION', entityId: transactionId,
          action: 'BATCH_ISSUE', payload: {
            batch_id: batchId, inventory_item_id: item.inventory_item_id,
            quantity: -Number(item.quantity), unit: item.unit,
          },
        });
      }
      await db.query(`
        UPDATE batches SET status='READY_FOR_PACKING',prepared_by=$1,prepared_at=now(),updated_at=now()
        WHERE id=$2
      `, [staff.id, batchId]);
      await db.query(`UPDATE orders SET status='READY_TO_DISPATCH',updated_at=now() WHERE id=$1`, [order.id]);
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'BATCH', entityId: batchId,
        action: 'COMPLETED', priorState: batch.status, resultingState: 'READY_FOR_PACKING',
        payload: { order_id: order.id },
      });
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'ORDER', entityId: order.id,
        action: 'PRODUCTION_COMPLETED', priorState: order.status, resultingState: 'READY_TO_DISPATCH',
        payload: { batch_id: batchId },
      });
    });
    return sameOriginRedirect('/admin/batches');
  } catch (error) {
    if (staff) {
      await writeAudit({ query }, {
        request, staffId: staff.id, entityType: 'BATCH', action,
        outcome: 'REJECTED', payload: { code: error?.code === '23514' ? 'INSUFFICIENT_STOCK' : (error.code || 'UNEXPECTED') },
      }).catch(() => {});
    }
    if (error?.code === '23514') return errorResponse(new HttpError(409, 'Inventory could not be consumed safely.', 'INSUFFICIENT_STOCK'));
    return errorResponse(error);
  }
}
