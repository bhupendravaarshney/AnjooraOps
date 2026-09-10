import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFormulaIngredientSelections } from '../lib/formula-ingredients.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

test('formula ingredient selections retain catalogue IDs and numeric quantities', () => {
  assert.deepEqual(parseFormulaIngredientSelections([first, second], ['30', '12.5']), [
    { ingredientId: first, quantity: 30 },
    { ingredientId: second, quantity: 12.5 },
  ]);
});

test('blank formula ingredient rows are ignored', () => {
  assert.deepEqual(parseFormulaIngredientSelections(['', first, ''], ['', '5', '']), [
    { ingredientId: first, quantity: 5 },
  ]);
});

test('formula ingredient selections reject incomplete, duplicate, and forged rows', () => {
  assert.throws(() => parseFormulaIngredientSelections([first], ['']), /both an ingredient and quantity/);
  assert.throws(() => parseFormulaIngredientSelections([first, first], ['1', '2']), /same ingredient twice/);
  assert.throws(() => parseFormulaIngredientSelections(['RM-ASHWAGANDHA'], ['2']), /invalid catalogue ID/);
  assert.throws(() => parseFormulaIngredientSelections([first], ['0']), /invalid quantity/);
  assert.throws(() => parseFormulaIngredientSelections([first], ['0.0001']), /invalid quantity/);
  assert.throws(() => parseFormulaIngredientSelections([first], ['1.2345']), /invalid quantity/);
});
