CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'ADMIN',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_staff ON sessions(staff_user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  name text NOT NULL,
  phone text NOT NULL UNIQUE,
  city text,
  language text,
  best_contact_time text,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consultations (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  folio_id text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  concern text NOT NULL,
  main_goal text,
  duration text,
  daily_effect text,
  appetite_digestion text,
  body_climate text,
  energy_pattern text,
  meal_rhythm text,
  sleep_rhythm text,
  realistic_rituals jsonb NOT NULL DEFAULT '[]'::jsonb,
  stress_response text,
  emotional_support text,
  change_style text,
  preferred_format text,
  questionnaire_version text NOT NULL DEFAULT '1.0',
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_text text,
  consent_at timestamptz,
  folio_text text NOT NULL,
  status text NOT NULL DEFAULT 'SUBMITTED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consultations_customer ON consultations(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consultations_status ON consultations(status, created_at DESC);

CREATE TABLE IF NOT EXISTS review_cases (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  consultation_id uuid NOT NULL UNIQUE REFERENCES consultations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'NEW',
  assigned_to uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  clarification_question text,
  last_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_review_cases_status ON review_cases(status, created_at DESC);

CREATE TABLE IF NOT EXISTS consultation_notes (
  id uuid PRIMARY KEY,
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  author_type text NOT NULL,
  author_ref text,
  note_type text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consultation_notes_consultation ON consultation_notes(consultation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  format text,
  default_duration_days integer,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  unit text NOT NULL,
  reorder_level numeric(14,3) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS formulas (
  id uuid PRIMARY KEY,
  public_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  format text,
  instructions text,
  status text NOT NULL DEFAULT 'APPROVED',
  created_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(public_id, version)
);
CREATE INDEX IF NOT EXISTS idx_formulas_customer ON formulas(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS formula_items (
  id uuid PRIMARY KEY,
  formula_id uuid NOT NULL REFERENCES formulas(id) ON DELETE CASCADE,
  inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE SET NULL,
  ingredient_name text NOT NULL,
  quantity numeric(14,3) NOT NULL,
  unit text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recommendations (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE RESTRICT,
  review_case_id uuid NOT NULL REFERENCES review_cases(id) ON DELETE RESTRICT,
  summary text NOT NULL,
  fulfillment_type text NOT NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  formula_id uuid REFERENCES formulas(id) ON DELETE SET NULL,
  duration_days integer,
  usage_instructions text,
  status text NOT NULL DEFAULT 'APPROVED',
  created_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recommendations_consultation ON recommendations(consultation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE RESTRICT,
  recommendation_id uuid NOT NULL REFERENCES recommendations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'CONFIRMED',
  amount numeric(14,2),
  currency text NOT NULL DEFAULT 'INR',
  expected_duration_days integer,
  shipping_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  formula_id uuid REFERENCES formulas(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'unit',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batches (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  formula_id uuid REFERENCES formulas(id) ON DELETE SET NULL,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'PENDING',
  planned_quantity numeric(14,3),
  unit text,
  prepared_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  prepared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status, created_at DESC);

CREATE TABLE IF NOT EXISTS batch_items (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity numeric(14,3) NOT NULL,
  unit text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  batch_id uuid REFERENCES batches(id) ON DELETE SET NULL,
  transaction_type text NOT NULL,
  quantity numeric(14,3) NOT NULL,
  reference text,
  note text,
  created_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_item ON inventory_transactions(inventory_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dispatches (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  courier text,
  awb text,
  shipping_address text,
  status text NOT NULL DEFAULT 'READY_FOR_DISPATCH',
  dispatched_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispatches_status ON dispatches(status, created_at DESC);

CREATE TABLE IF NOT EXISTS refills (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  source_order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'NOT_DUE',
  decision text,
  next_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_order_id)
);
CREATE INDEX IF NOT EXISTS idx_refills_due ON refills(due_date, status);

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  customer_id uuid NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  active_consultation_id uuid REFERENCES consultations(id) ON DELETE SET NULL,
  active_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'BOT_ACTIVE',
  needs_human boolean NOT NULL DEFAULT false,
  assigned_to uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  meta_message_id text UNIQUE,
  direction text NOT NULL,
  message_type text NOT NULL DEFAULT 'text',
  body text,
  intent text,
  delivery_status text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  staff_user_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id, created_at DESC);

CREATE OR REPLACE VIEW inventory_stock AS
SELECT
  i.id,
  i.public_id,
  i.sku,
  i.name,
  i.unit,
  i.reorder_level,
  COALESCE(SUM(t.quantity), 0)::numeric(14,3) AS available_quantity
FROM inventory_items i
LEFT JOIN inventory_transactions t ON t.inventory_item_id = i.id
GROUP BY i.id, i.public_id, i.sku, i.name, i.unit, i.reorder_level;
