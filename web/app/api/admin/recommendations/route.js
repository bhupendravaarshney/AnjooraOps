import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/auth';
import { query, withTransaction } from '@/lib/db';
import { uuid, publicId } from '@/lib/ids';
import { writeAudit } from '@/lib/audit';
import { HttpError, errorResponse } from '@/lib/http';
import { parseFormulaIngredientSelections } from '@/lib/formula-ingredients';

function text(value, field, maximum, required = false) {
  const result = String(value || '').trim();
  if (required && !result) throw new HttpError(422, `${field} is required.`, 'VALIDATION_ERROR');
  if (result.length > maximum) throw new HttpError(422, `${field} is too long.`, 'VALIDATION_ERROR');
  return result || null;
}

function ingredientSelections(form) {
  try {
    return parseFormulaIngredientSelections(
      form.getAll('formula_ingredient_id'),
      form.getAll('formula_ingredient_quantity'),
    );
  } catch (error) {
    throw new HttpError(422, error.message, error.code || 'INVALID_INGREDIENT');
  }
}

export async function POST(request) {
  let staff = null;
  try {
    staff = await requireStaff({ request, capability: 'CLINICAL_REVIEW' });
    const form = await request.formData();
    const consultationId = String(form.get('consultation_id') || '');
    const expectedReviewStatus = String(form.get('expected_review_status') || '');
    const summary = text(form.get('summary'), 'Recommendation summary', 2000, true);
    const fulfillmentType = String(form.get('fulfillment_type') || '').trim().toUpperCase();
    const durationDays = Number(form.get('duration_days'));
    const usage = text(form.get('usage_instructions'), 'Usage instructions', 3000);
    const productReference = text(form.get('product_ref') || form.get('product_id'), 'Product', 100);
    const formulaName = text(form.get('formula_name'), 'Formula name', 160);
    const formulaFormat = text(form.get('formula_format'), 'Formula format', 80);
    const ingredients = ingredientSelections(form);
    const previousFormulaId = String(form.get('previous_formula_id') || '') || null;
    if (!consultationId) throw new HttpError(422, 'consultation_id is required.', 'VALIDATION_ERROR');
    if (!['STANDARD', 'PERSONALISED'].includes(fulfillmentType)) {
      throw new HttpError(422, 'Fulfillment type must be STANDARD or PERSONALISED.', 'INVALID_FULFILLMENT');
    }
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
      throw new HttpError(422, 'Duration must be a whole number from 1 to 3650 days.', 'INVALID_DURATION');
    }
    if (fulfillmentType === 'STANDARD' && !productReference) {
      throw new HttpError(422, 'A standard recommendation requires a product.', 'PRODUCT_REQUIRED');
    }
    if (fulfillmentType === 'STANDARD' && ingredients.length) {
      throw new HttpError(422, 'A standard recommendation cannot also contain formula ingredients.', 'MIXED_FULFILLMENT');
    }
    if (fulfillmentType === 'PERSONALISED' && productReference) {
      throw new HttpError(422, 'A personalised recommendation cannot also select a product.', 'MIXED_FULFILLMENT');
    }
    if (fulfillmentType === 'PERSONALISED' && !previousFormulaId && (!formulaName || !ingredients.length)) {
      throw new HttpError(422, 'A new personalised formula requires a name and at least one ingredient.', 'EMPTY_FORMULA');
    }

    const recommendation = await withTransaction(async (db) => {
      const context = (await db.query(`
        SELECT c.customer_id,c.urgent_safety_flag,c.status consultation_status,
               rc.id review_case_id,rc.status review_status
        FROM consultations c JOIN review_cases rc ON rc.consultation_id=c.id
        WHERE c.id=$1 FOR UPDATE OF c,rc
      `, [consultationId])).rows[0];
      if (!context) throw new HttpError(404, 'Consultation not found.', 'NOT_FOUND');
      if (!expectedReviewStatus) throw new HttpError(422, 'expected_review_status is required.', 'EXPECTED_STATE_REQUIRED');
      if (context.review_status !== expectedReviewStatus) {
        throw new HttpError(409, `Review state changed: expected ${expectedReviewStatus}, found ${context.review_status}.`, 'STALE_STATE');
      }
      if (context.review_status !== 'READY_FOR_RECOMMENDATION') {
        throw new HttpError(409, 'Review is not ready for recommendation approval.', 'INVALID_REVIEW_STATE');
      }
      if (context.urgent_safety_flag) throw new HttpError(409, 'Recommendation is blocked by an urgent safety flag.', 'SAFETY_BLOCK');

      const current = (await db.query(`
        SELECT * FROM recommendations
        WHERE consultation_id=$1 AND is_current=true AND status='APPROVED'
        FOR UPDATE
      `, [consultationId])).rows[0] || null;
      let formulaId = null;
      let productId = null;
      if (fulfillmentType === 'STANDARD') {
        const product = (await db.query(`
          SELECT * FROM products WHERE id::text=$1 OR public_id=$1 OR upper(sku)=upper($1) LIMIT 1 FOR UPDATE
        `, [productReference])).rows[0];
        if (!product?.active) throw new HttpError(409, 'The selected product is unavailable.', 'PRODUCT_UNAVAILABLE');
        productId = product.id;
      } else {
        let previous = null;
        let formulaPublicId = publicId('ANJ-FRM');
        let formulaVersion = 1;
        if (previousFormulaId) {
          previous = (await db.query(`SELECT * FROM formulas WHERE id=$1 FOR UPDATE`, [previousFormulaId])).rows[0];
          if (!previous) throw new HttpError(404, 'Previous formula not found.', 'NOT_FOUND');
          if (previous.customer_id !== context.customer_id) {
            throw new HttpError(409, 'Previous formula belongs to a different customer.', 'FORMULA_OWNERSHIP_MISMATCH');
          }
          await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`formula:${previous.public_id}`]);
          formulaPublicId = previous.public_id;
          formulaVersion = Number((await db.query(`SELECT COALESCE(MAX(version),0)+1 next_version FROM formulas WHERE public_id=$1`, [formulaPublicId])).rows[0].next_version);
        }
        let finalIngredients = ingredients;
        if (!finalIngredients.length && previous) {
          finalIngredients = (await db.query(`
            SELECT fi.formula_ingredient_id "ingredientId",fi.quantity
            FROM formula_items fi
            WHERE fi.formula_id=$1 ORDER BY fi.id
          `, [previous.id])).rows.map((item) => ({ ...item, quantity: Number(item.quantity) }));
        }
        if (!finalIngredients.length) throw new HttpError(422, 'Personalised formula requires ingredients.', 'EMPTY_FORMULA');

        const catalogue = await db.query(`
          SELECT ingredient.id,ingredient.name,ingredient.inventory_item_id,
                 ingredient.active,ii.sku,ii.unit,ii.active inventory_active
          FROM formula_ingredients ingredient
          JOIN inventory_items ii ON ii.id=ingredient.inventory_item_id
          WHERE ingredient.id=ANY($1::uuid[])
          FOR UPDATE OF ingredient,ii
        `, [finalIngredients.map((item) => item.ingredientId)]);
        const catalogueById = new Map(catalogue.rows.map((item) => [item.id, item]));
        const mappedIngredients = finalIngredients.map((selection, index) => {
          const ingredient = catalogueById.get(selection.ingredientId);
          if (!ingredient?.active || !ingredient.inventory_active) {
            throw new HttpError(409, `Formula ingredient row ${index + 1} is unavailable.`, 'INGREDIENT_UNAVAILABLE');
          }
          return {
            ...selection,
            name: ingredient.name,
            sku: ingredient.sku,
            unit: ingredient.unit,
            inventoryItemId: ingredient.inventory_item_id,
          };
        });
        formulaId = uuid();
        await db.query(`
          INSERT INTO formulas(
            id,public_id,version,customer_id,consultation_id,name,format,instructions,status,created_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'APPROVED',$9)
        `, [
          formulaId, formulaPublicId, formulaVersion, context.customer_id, consultationId,
          formulaName || previous?.name, formulaFormat || previous?.format, usage || previous?.instructions, staff.id,
        ]);
        for (const item of mappedIngredients) {
          await db.query(`
            INSERT INTO formula_items(
              id,formula_id,formula_ingredient_id,inventory_item_id,ingredient_name,quantity,unit
            ) VALUES($1,$2,$3,$4,$5,$6,$7)
          `, [uuid(), formulaId, item.ingredientId, item.inventoryItemId, item.name, item.quantity, item.unit]);
        }
      }

      if (current) await db.query(`UPDATE recommendations SET is_current=false,updated_at=now() WHERE id=$1`, [current.id]);
      const recommendationId = uuid();
      const created = (await db.query(`
        INSERT INTO recommendations(
          id,public_id,consultation_id,review_case_id,summary,fulfillment_type,product_id,
          formula_id,duration_days,usage_instructions,status,created_by,supersedes_recommendation_id,is_current
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'APPROVED',$11,$12,true)
        RETURNING *
      `, [
        recommendationId, publicId('ANJ-REC'), consultationId, context.review_case_id, summary,
        fulfillmentType, productId, formulaId, durationDays, usage, staff.id, current?.id || null,
      ])).rows[0];
      await db.query(`UPDATE review_cases SET status='APPROVED',assigned_to=$1,last_reviewed_at=now(),updated_at=now() WHERE id=$2`, [staff.id, context.review_case_id]);
      await db.query(`UPDATE consultations SET status='REVIEWED',updated_at=now() WHERE id=$1`, [consultationId]);
      if (current) {
        await writeAudit(db, {
          request, staffId: staff.id, entityType: 'RECOMMENDATION', entityId: current.id,
          action: 'SUPERSEDED', priorState: 'CURRENT', resultingState: 'SUPERSEDED',
          payload: { superseded_by: recommendationId },
        });
      }
      await writeAudit(db, {
        request, staffId: staff.id, entityType: 'RECOMMENDATION', entityId: recommendationId,
        action: 'CREATED', resultingState: 'APPROVED',
        payload: { fulfillment_type: fulfillmentType, duration_days: durationDays, formula_id: formulaId, product_id: productId },
      });
      return created;
    });
    return NextResponse.redirect(new URL(`/admin/consultations/${consultationId}?recommendation=${recommendation.public_id}`, request.url), 303);
  } catch (error) {
    if (staff) {
      await writeAudit({ query }, {
        request, staffId: staff.id, entityType: 'RECOMMENDATION', action: 'CREATE',
        outcome: 'REJECTED', payload: { code: error.code || 'UNEXPECTED' },
      }).catch(() => {});
    }
    if (error?.code === '23505') return errorResponse(new HttpError(409, 'A concurrent recommendation or formula revision already exists.', 'CONCURRENT_REVISION'));
    return errorResponse(error);
  }
}
