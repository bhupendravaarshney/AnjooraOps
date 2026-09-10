'use client';

import { useRef, useState } from 'react';

function FormulaIngredientPicker({ ingredients, initialItems, disabled = false }) {
  const initialRows = (initialItems || [])
    .filter((item) => item.formula_ingredient_id)
    .map((item, index) => ({
      key: `existing-${index}`,
      ingredientId: item.formula_ingredient_id,
      quantity: String(item.quantity || ''),
    }));
  const [rows, setRows] = useState(initialRows.length ? initialRows : [{ key: 'ingredient-0', ingredientId: '', quantity: '' }]);
  const nextKey = useRef(rows.length);
  const byId = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));

  function update(key, field, value) {
    setRows((current) => current.map((row) => {
      if (row.key !== key) return row;
      if (field === 'ingredientId' && !value) return { ...row, ingredientId: '', quantity: '' };
      return { ...row, [field]: value };
    }));
  }

  function remove(key) {
    setRows((current) => current.length === 1
      ? [{ ...current[0], ingredientId: '', quantity: '' }]
      : current.filter((row) => row.key !== key));
  }

  function add() {
    if (rows.length >= 100) return;
    const key = `ingredient-${nextKey.current}`;
    nextKey.current += 1;
    setRows((current) => [...current, { key, ingredientId: '', quantity: '' }]);
  }

  if (!ingredients.length) {
    return <div className="notice">No active formula ingredients are configured. An administrator or operations user must add them from Inventory before this formula can be approved.</div>;
  }

  return <div className="field">
    <label>Formula ingredients</label>
    <div className="stack">
      {rows.map((row, index) => {
        const selected = byId.get(row.ingredientId);
        return <div className="row" key={row.key}>
          <select
            name="formula_ingredient_id"
            aria-label={`Formula ingredient ${index + 1}`}
            value={row.ingredientId}
            disabled={disabled}
            onChange={(event) => update(row.key, 'ingredientId', event.target.value)}
            style={{ flex: '2 1 280px' }}
          >
            <option value="">Select an ingredient</option>
            {ingredients.map((ingredient) => <option value={ingredient.id} key={ingredient.id}>
              {ingredient.sku} - {ingredient.name} ({ingredient.unit})
            </option>)}
          </select>
          <input
            name="formula_ingredient_quantity"
            aria-label={`Formula ingredient quantity ${index + 1}`}
            type="number"
            min="0.001"
            max="1000000"
            step="0.001"
            placeholder="Quantity"
            value={row.quantity}
            disabled={disabled}
            required={Boolean(row.ingredientId)}
            onChange={(event) => update(row.key, 'quantity', event.target.value)}
            style={{ flex: '1 1 140px' }}
          />
          <span className="small muted" style={{ minWidth: 36 }}>{selected?.unit || '-'}</span>
          <button className="btn secondary" type="button" onClick={() => remove(row.key)} disabled={disabled}>Remove</button>
        </div>;
      })}
      <div><button className="btn outline" type="button" onClick={add} disabled={disabled || rows.length >= 100}>Add ingredient</button></div>
    </div>
  </div>;
}

export default function RecommendationFulfilmentFields({
  initialType = 'STANDARD',
  initialProductRef = '',
  initialFormulaName = '',
  initialFormulaFormat = '',
  ingredients = [],
  initialItems = [],
}) {
  const [fulfilmentType, setFulfilmentType] = useState(initialType);
  const personalised = fulfilmentType === 'PERSONALISED';

  return <>
    <div className="grid grid-2">
      <div className="field">
        <label>Fulfilment</label>
        <select name="fulfillment_type" value={fulfilmentType} onChange={(event) => setFulfilmentType(event.target.value)}>
          <option value="STANDARD">Standard product</option>
          <option value="PERSONALISED">Personalised formula</option>
        </select>
      </div>
      <div className="field" hidden={personalised}>
        <label>Standard product SKU or public ID</label>
        <input name="product_ref" required={!personalised} disabled={personalised} defaultValue={initialProductRef} placeholder="ANJ-SLEEP-01" maxLength={100}/>
      </div>
      <div className="field" hidden={!personalised}>
          <label>Formula name</label>
          <input name="formula_name" required={personalised} disabled={!personalised} defaultValue={initialFormulaName} placeholder="Sleep support infusion" maxLength={160}/>
      </div>
      <div className="field" hidden={!personalised}>
          <label>Formula format</label>
          <input name="formula_format" disabled={!personalised} defaultValue={initialFormulaFormat} placeholder="infusion" maxLength={80}/>
      </div>
    </div>
    <div hidden={!personalised}>
      <FormulaIngredientPicker ingredients={ingredients} initialItems={initialItems} disabled={!personalised}/>
    </div>
  </>;
}
