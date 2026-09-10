CREATE TABLE IF NOT EXISTS formula_ingredients (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  inventory_item_id uuid NOT NULL UNIQUE REFERENCES inventory_items(id) ON DELETE RESTRICT,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT formula_ingredients_name_length CHECK (char_length(btrim(name)) BETWEEN 2 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_formula_ingredients_active_name
  ON formula_ingredients(active,lower(name),id);

ALTER TABLE formula_ingredients
  DROP CONSTRAINT IF EXISTS formula_ingredients_id_inventory_unique;
ALTER TABLE formula_ingredients
  ADD CONSTRAINT formula_ingredients_id_inventory_unique UNIQUE(id,inventory_item_id);

-- Preserve every ingredient already used by a formula as an active catalogue row.
-- Reusing the inventory UUID is deterministic and safe because it is scoped to this table.
INSERT INTO formula_ingredients(id,public_id,inventory_item_id,name,active)
SELECT
  ii.id,
  'ANJ-FING-' || upper(replace(ii.id::text,'-','')),
  ii.id,
  min(fi.ingredient_name),
  ii.active
FROM formula_items fi
JOIN inventory_items ii ON ii.id=fi.inventory_item_id
GROUP BY ii.id,ii.active
ON CONFLICT(inventory_item_id) DO NOTHING;

ALTER TABLE formula_items
  ADD COLUMN IF NOT EXISTS formula_ingredient_id uuid;

UPDATE formula_items fi
SET formula_ingredient_id=ingredient.id
FROM formula_ingredients ingredient
WHERE ingredient.inventory_item_id=fi.inventory_item_id
  AND fi.formula_ingredient_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM formula_items WHERE formula_ingredient_id IS NULL) THEN
    RAISE EXCEPTION 'Every existing formula item must map to the formula ingredient catalogue.';
  END IF;
END $$;

ALTER TABLE formula_items
  ALTER COLUMN formula_ingredient_id SET NOT NULL;

ALTER TABLE formula_items
  DROP CONSTRAINT IF EXISTS formula_items_formula_ingredient_id_fkey;
ALTER TABLE formula_items
  ADD CONSTRAINT formula_items_formula_ingredient_id_fkey
  FOREIGN KEY (formula_ingredient_id) REFERENCES formula_ingredients(id) ON DELETE RESTRICT;

ALTER TABLE formula_items
  DROP CONSTRAINT IF EXISTS formula_items_catalog_inventory_fkey;
ALTER TABLE formula_items
  ADD CONSTRAINT formula_items_catalog_inventory_fkey
  FOREIGN KEY (formula_ingredient_id,inventory_item_id)
  REFERENCES formula_ingredients(id,inventory_item_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_formula_items_one_catalog_ingredient
  ON formula_items(formula_id,formula_ingredient_id);
