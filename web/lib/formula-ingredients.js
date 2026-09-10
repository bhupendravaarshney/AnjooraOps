const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUANTITY_PATTERN = /^(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/;

function inputError(message, code = 'INVALID_INGREDIENT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseFormulaIngredientSelections(rawIds, rawQuantities) {
  const ids = Array.from(rawIds || [], (value) => String(value || '').trim());
  const quantities = Array.from(rawQuantities || [], (value) => String(value || '').trim());
  const rowCount = Math.max(ids.length, quantities.length);
  if (rowCount > 100) throw inputError('A formula can contain at most 100 ingredients.', 'TOO_MANY_INGREDIENTS');

  const selections = [];
  const seen = new Set();
  for (let index = 0; index < rowCount; index += 1) {
    const ingredientId = ids[index] || '';
    const rawQuantity = quantities[index] || '';
    if (!ingredientId && !rawQuantity) continue;
    if (!ingredientId || !rawQuantity) {
      throw inputError(`Formula ingredient row ${index + 1} requires both an ingredient and quantity.`);
    }
    if (!UUID_PATTERN.test(ingredientId)) {
      throw inputError(`Formula ingredient row ${index + 1} has an invalid catalogue ID.`);
    }
    const quantity = Number(rawQuantity);
    if (!QUANTITY_PATTERN.test(rawQuantity) || !Number.isFinite(quantity) || quantity < 0.001 || quantity > 1_000_000) {
      throw inputError(`Formula ingredient row ${index + 1} has an invalid quantity.`);
    }
    if (seen.has(ingredientId)) throw inputError('A formula cannot contain the same ingredient twice.', 'DUPLICATE_INGREDIENT');
    seen.add(ingredientId);
    selections.push({ ingredientId, quantity });
  }
  return selections;
}
