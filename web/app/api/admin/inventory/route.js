import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse, sameOriginRedirect } from '@/lib/http';
import { normalizeUnit } from '@/lib/units';

const ACTIONS = new Set([
  'create_item',
  'map_product',
  'receipt',
  'adjustment',
  'upsert_formula_ingredient',
  'set_formula_ingredient_active',
]);

function boundedText(value, field, maximum, required = false) {
  const text = String(value || '').trim();
  if (required && !text) throw new HttpError(422, `${field} is required.`, 'VALIDATION_ERROR');
  if (text.length > maximum) throw new HttpError(422, `${field} is too long.`, 'VALIDATION_ERROR');
  return text || null;
}

export async function POST(request) {
  let staff = null;
  let action = 'UNKNOWN';
  try {
    staff = await requireStaff({ request, capability: 'OPERATIONS' });
    const form = await request.formData();
    action = String(form.get('action') || '').trim().toLowerCase();
    if (!ACTIONS.has(action)) throw new HttpError(422, 'Unsupported inventory action.', 'UNKNOWN_ACTION');

    if (action === 'create_item') {
      const sku = boundedText(form.get('sku'), 'SKU', 64, true).toUpperCase();
      const name = boundedText(form.get('name'), 'Name', 120, true);
      const unit = normalizeUnit(form.get('unit'));
      const reorderLevel = Number(form.get('reorder_level') || 0);
      if (!/^[A-Z0-9][A-Z0-9._/-]{1,63}$/.test(sku)) {
        throw new HttpError(422, 'SKU contains unsupported characters.', 'INVALID_SKU');
      }
      if (!Number.isFinite(reorderLevel) || reorderLevel < 0 || reorderLevel > 1_000_000_000) {
        throw new HttpError(422, 'Reorder level must be a non-negative number.', 'INVALID_QUANTITY');
      }

      await withTransaction(async (db) => {
        await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`inventory-sku:${sku}`]);
        const existing = (await db.query(`SELECT * FROM inventory_items WHERE sku=$1 FOR UPDATE`, [sku])).rows[0];
        let item;
        let priorState = null;
        if (existing) {
          priorState = JSON.stringify({ name: existing.name, unit: existing.unit, reorder_level: existing.reorder_level });
          if (existing.unit !== unit) {
            const usage = await db.query(`
              SELECT EXISTS(SELECT 1 FROM inventory_transactions WHERE inventory_item_id=$1) AS ledger_used,
                     EXISTS(SELECT 1 FROM formula_items WHERE inventory_item_id=$1) AS formula_used
            `, [existing.id]);
            if (usage.rows[0].ledger_used || usage.rows[0].formula_used) {
              throw new HttpError(409, 'Unit cannot change after an item is used by stock or a formula.', 'UNIT_IMMUTABLE');
            }
          }
          item = (await db.query(`
            UPDATE inventory_items SET name=$1,unit=$2,reorder_level=$3,updated_at=now()
            WHERE id=$4 RETURNING *
          `, [name, unit, reorderLevel, existing.id])).rows[0];
        } else {
          item = (await db.query(`
            INSERT INTO inventory_items(id,public_id,sku,name,unit,reorder_level)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING *
          `, [uuid(), publicId('ANJ-INV'), sku, name, unit, reorderLevel])).rows[0];
        }
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'INVENTORY_ITEM', entityId: item.id,
          action: existing ? 'UPDATED' : 'CREATED', priorState,
          resultingState: JSON.stringify({ name: item.name, unit: item.unit, reorder_level: item.reorder_level }),
          payload: { sku: item.sku },
        });
      });
    } else if (action === 'map_product') {
      const productReference = boundedText(form.get('product_ref') || form.get('product_id'), 'Product', 100, true);
      const itemReference = boundedText(form.get('item_ref') || form.get('item_id'), 'Inventory item', 100, true);
      const quantity = Number(form.get('quantity'));
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
        throw new HttpError(422, 'Finished-goods quantity must be positive.', 'INVALID_QUANTITY');
      }
      await withTransaction(async (db) => {
        const product = (await db.query(`
          SELECT * FROM products WHERE id::text=$1 OR public_id=$1 OR upper(sku)=upper($1) LIMIT 1 FOR UPDATE
        `, [productReference])).rows[0];
        const item = (await db.query(`
          SELECT * FROM inventory_items WHERE id::text=$1 OR public_id=$1 OR upper(sku)=upper($1) LIMIT 1 FOR UPDATE
        `, [itemReference])).rows[0];
        if (!product || !item) throw new HttpError(404, 'Product or inventory item not found.', 'NOT_FOUND');
        await db.query(`UPDATE products SET inventory_item_id=$1,inventory_quantity=$2,updated_at=now() WHERE id=$3`, [item.id, quantity, product.id]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'PRODUCT', entityId: product.id,
          action: 'INVENTORY_MAPPING_UPDATED',
          priorState: product.inventory_item_id ? `${product.inventory_item_id}:${product.inventory_quantity}` : null,
          resultingState: `${item.id}:${quantity}`,
          payload: { inventory_item_id: item.id, sku: item.sku, quantity, unit: item.unit },
        });
      });
    } else if (action === 'upsert_formula_ingredient') {
      const itemReference = boundedText(form.get('item_ref') || form.get('item_id'), 'Inventory item', 100, true);
      const requestedName = boundedText(form.get('ingredient_name'), 'Ingredient name', 120);
      await withTransaction(async (db) => {
        const item = (await db.query(`
          SELECT * FROM inventory_items
          WHERE id::text=$1 OR public_id=$1 OR upper(sku)=upper($1)
          LIMIT 1 FOR UPDATE
        `, [itemReference])).rows[0];
        if (!item?.active) throw new HttpError(409, 'The inventory item is unavailable.', 'ITEM_UNAVAILABLE');
        const name = requestedName || item.name;
        if (name.length < 2) throw new HttpError(422, 'Ingredient name must contain at least two characters.', 'VALIDATION_ERROR');
        await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`formula-ingredient:${item.id}`]);
        const existing = (await db.query(`SELECT * FROM formula_ingredients WHERE inventory_item_id=$1 FOR UPDATE`, [item.id])).rows[0];
        const ingredient = existing
          ? (await db.query(`
              UPDATE formula_ingredients
              SET name=$1,active=true,updated_by=$2,updated_at=now()
              WHERE id=$3 RETURNING *
            `, [name, staff.id, existing.id])).rows[0]
          : (await db.query(`
              INSERT INTO formula_ingredients(
                id,public_id,inventory_item_id,name,created_by,updated_by
              ) VALUES($1,$2,$3,$4,$5,$5) RETURNING *
            `, [uuid(), publicId('ANJ-FING'), item.id, name, staff.id])).rows[0];
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'FORMULA_INGREDIENT', entityId: ingredient.id,
          action: existing ? 'UPDATED' : 'CREATED',
          priorState: existing ? JSON.stringify({ name: existing.name, active: existing.active }) : null,
          resultingState: JSON.stringify({ name: ingredient.name, active: ingredient.active }),
          payload: { inventory_item_id: item.id, sku: item.sku, unit: item.unit },
        });
      });
    } else if (action === 'set_formula_ingredient_active') {
      const ingredientReference = boundedText(form.get('ingredient_ref') || form.get('ingredient_id'), 'Formula ingredient', 100, true);
      const activeValue = String(form.get('active') || '').trim().toLowerCase();
      if (!['true', 'false'].includes(activeValue)) throw new HttpError(422, 'Ingredient active state is invalid.', 'VALIDATION_ERROR');
      const active = activeValue === 'true';
      await withTransaction(async (db) => {
        const ingredient = (await db.query(`
          SELECT ingredient.*,ii.sku,ii.active inventory_active
          FROM formula_ingredients ingredient
          JOIN inventory_items ii ON ii.id=ingredient.inventory_item_id
          WHERE ingredient.id::text=$1 OR ingredient.public_id=$1
          LIMIT 1 FOR UPDATE OF ingredient
        `, [ingredientReference])).rows[0];
        if (!ingredient) throw new HttpError(404, 'Formula ingredient not found.', 'NOT_FOUND');
        if (active && !ingredient.inventory_active) {
          throw new HttpError(409, 'Reactivate the inventory item before this formula ingredient.', 'ITEM_UNAVAILABLE');
        }
        await db.query(`UPDATE formula_ingredients SET active=$1,updated_by=$2,updated_at=now() WHERE id=$3`, [active, staff.id, ingredient.id]);
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'FORMULA_INGREDIENT', entityId: ingredient.id,
          action: active ? 'ACTIVATED' : 'DEACTIVATED',
          priorState: String(ingredient.active), resultingState: String(active), payload: { sku: ingredient.sku },
        });
      });
    } else {
      const itemReference = boundedText(form.get('item_ref') || form.get('item_id'), 'Item', 100, true);
      let quantity = Number(form.get('quantity'));
      if (!Number.isFinite(quantity) || quantity === 0 || Math.abs(quantity) > 1_000_000_000) {
        throw new HttpError(422, 'A valid non-zero quantity is required.', 'INVALID_QUANTITY');
      }
      if (action === 'receipt') quantity = Math.abs(quantity);
      const reference = boundedText(form.get('reference'), 'Reference', 120);
      const note = boundedText(form.get('note'), 'Note', 500);

      await withTransaction(async (db) => {
        const item = (await db.query(`
          SELECT * FROM inventory_items WHERE id::text=$1 OR public_id=$1 OR upper(sku)=upper($1) LIMIT 1 FOR UPDATE
        `, [itemReference])).rows[0];
        if (!item) throw new HttpError(404, 'Inventory item not found.', 'NOT_FOUND');
        const itemId = item.id;
        const balance = Number((await db.query(`
          SELECT COALESCE(SUM(quantity),0)::numeric AS quantity
          FROM inventory_transactions WHERE inventory_item_id=$1
        `, [itemId])).rows[0].quantity);
        const resultingBalance = balance + quantity;
        if (resultingBalance < 0) throw new HttpError(409, 'This adjustment would make stock negative.', 'INSUFFICIENT_STOCK');
        const transaction = (await db.query(`
          INSERT INTO inventory_transactions(
            id,inventory_item_id,transaction_type,quantity,reference,note,created_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id
        `, [uuid(), itemId, action === 'receipt' ? 'RECEIPT' : 'ADJUSTMENT', quantity, reference, note, staff.id])).rows[0];
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'INVENTORY_TRANSACTION', entityId: transaction.id,
          action: action.toUpperCase(), priorState: String(balance), resultingState: String(resultingBalance),
          payload: { inventory_item_id: itemId, sku: item.sku, quantity, unit: item.unit, reference },
        });
      });
    }
    return sameOriginRedirect('/admin/inventory');
  } catch (error) {
    if (staff) {
      await writeAudit({ query }, {
        request, staffId: staff.id, entityType: 'INVENTORY', action,
        outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' },
      }).catch(() => {});
    }
    return errorResponse(error);
  }
}
