ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS must_rotate_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_secret_encrypted text;

ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check
  CHECK (role IN ('ADMIN', 'VAIDYA', 'OPERATIONS', 'SUPPORT'));

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS ip_hash text,
  ADD COLUMN IF NOT EXISTS user_agent_hash text;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS identity_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz,
  ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS submission_id uuid,
  ADD COLUMN IF NOT EXISTS submission_response jsonb,
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS source_ip_hash text,
  ADD COLUMN IF NOT EXISTS raw_payload_purged_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consultations_submission_id
  ON consultations(submission_id)
  WHERE submission_id IS NOT NULL;

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN IF NOT EXISTS processing_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS raw_payload_purged_at timestamptz;

UPDATE whatsapp_messages
SET processing_status='PROCESSED', processed_at=COALESCE(processed_at, created_at)
WHERE direction='INBOUND' AND processing_status='NOT_APPLICABLE';

ALTER TABLE whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_processing_status_check;
ALTER TABLE whatsapp_messages ADD CONSTRAINT whatsapp_messages_processing_status_check
  CHECK (processing_status IN ('NOT_APPLICABLE', 'QUEUED', 'PROCESSING', 'PROCESSED', 'FAILED'));

CREATE TABLE IF NOT EXISTS message_outbox (
  id uuid PRIMARY KEY,
  job_type text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING',
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (job_type IN ('BOT_INBOUND', 'WHATSAPP_TEXT', 'WHATSAPP_TEMPLATE')),
  CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD')),
  CHECK (attempts >= 0),
  CHECK (max_attempts BETWEEN 1 AND 20)
);
CREATE INDEX IF NOT EXISTS idx_message_outbox_ready
  ON message_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope text NOT NULL,
  key_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_lookup
  ON rate_limit_events(scope, key_hash, created_at DESC);

UPDATE inventory_items SET unit='unit' WHERE lower(unit) IN ('pc','pcs','piece','pieces','each','ea');
UPDATE formula_items SET unit='unit' WHERE lower(unit) IN ('pc','pcs','piece','pieces','each','ea');
UPDATE batch_items SET unit='unit' WHERE lower(unit) IN ('pc','pcs','piece','pieces','each','ea');

ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_reorder_nonnegative;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_reorder_nonnegative CHECK (reorder_level >= 0);
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_unit_check;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_unit_check CHECK (lower(unit) IN ('g', 'kg', 'ml', 'l', 'unit'));

ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_quantity_nonzero;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_quantity_nonzero CHECK (quantity <> 0);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS inventory_item_id uuid REFERENCES inventory_items(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS inventory_quantity numeric(14,3);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_inventory_quantity_positive;
ALTER TABLE products ADD CONSTRAINT products_inventory_quantity_positive
  CHECK (inventory_quantity IS NULL OR inventory_quantity > 0);

ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_one_standard_issue
  ON inventory_transactions(order_id,inventory_item_id)
  WHERE order_id IS NOT NULL AND transaction_type='ORDER_ISSUE';

ALTER TABLE formula_items DROP CONSTRAINT IF EXISTS formula_items_quantity_positive;
ALTER TABLE formula_items ADD CONSTRAINT formula_items_quantity_positive CHECK (quantity > 0);
ALTER TABLE formula_items DROP CONSTRAINT IF EXISTS formula_items_unit_check;
ALTER TABLE formula_items ADD CONSTRAINT formula_items_unit_check CHECK (lower(unit) IN ('g', 'kg', 'ml', 'l', 'unit'));
ALTER TABLE formula_items DROP CONSTRAINT IF EXISTS formula_items_inventory_item_id_fkey;
ALTER TABLE formula_items ALTER COLUMN inventory_item_id SET NOT NULL;
ALTER TABLE formula_items ADD CONSTRAINT formula_items_inventory_item_id_fkey
  FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE RESTRICT;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_quantity_positive;
ALTER TABLE order_items ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0);

ALTER TABLE batch_items DROP CONSTRAINT IF EXISTS batch_items_quantity_positive;
ALTER TABLE batch_items ADD CONSTRAINT batch_items_quantity_positive CHECK (quantity > 0);
ALTER TABLE batch_items DROP CONSTRAINT IF EXISTS batch_items_unit_check;
ALTER TABLE batch_items ADD CONSTRAINT batch_items_unit_check CHECK (lower(unit) IN ('g', 'kg', 'ml', 'l', 'unit'));

ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS production_quantity numeric(14,3) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS wastage_percent numeric(6,3) NOT NULL DEFAULT 0;
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_production_quantity_positive;
ALTER TABLE batches ADD CONSTRAINT batches_production_quantity_positive CHECK (production_quantity > 0);
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_wastage_range;
ALTER TABLE batches ADD CONSTRAINT batches_wastage_range CHECK (wastage_percent >= 0 AND wastage_percent <= 25);
UPDATE batches SET status='READY_FOR_PACKING' WHERE status='COMPLETED';
ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_status_check;
ALTER TABLE batches ADD CONSTRAINT batches_status_check CHECK (status IN ('PENDING','READY_FOR_PACKING'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_one_per_order ON batches(order_id);

CREATE OR REPLACE FUNCTION enforce_nonnegative_inventory_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_balance numeric(14,3);
BEGIN
  PERFORM 1 FROM inventory_items WHERE id=NEW.inventory_item_id FOR UPDATE;
  SELECT COALESCE(SUM(quantity), 0)::numeric(14,3)
    INTO current_balance
    FROM inventory_transactions
    WHERE inventory_item_id=NEW.inventory_item_id;
  IF current_balance + NEW.quantity < 0 THEN
    RAISE EXCEPTION 'inventory balance cannot become negative'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_nonnegative ON inventory_transactions;
CREATE TRIGGER trg_inventory_nonnegative
BEFORE INSERT ON inventory_transactions
FOR EACH ROW EXECUTE FUNCTION enforce_nonnegative_inventory_balance();

CREATE OR REPLACE FUNCTION prevent_inventory_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory ledger entries are immutable'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_ledger_immutable ON inventory_transactions;
CREATE TRIGGER trg_inventory_ledger_immutable
BEFORE UPDATE OR DELETE ON inventory_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_inventory_ledger_mutation();

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS supersedes_recommendation_id uuid REFERENCES recommendations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY consultation_id ORDER BY created_at DESC, id DESC) AS position
  FROM recommendations
)
UPDATE recommendations r
SET is_current=(ranked.position=1)
FROM ranked
WHERE ranked.id=r.id;

ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_duration_positive;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_duration_positive CHECK (duration_days IS NULL OR duration_days > 0);
ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_fulfillment_links;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_fulfillment_links CHECK (
  (fulfillment_type='STANDARD' AND product_id IS NOT NULL AND formula_id IS NULL)
  OR
  (fulfillment_type='PERSONALISED' AND formula_id IS NOT NULL AND product_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_one_current
  ON recommendations(consultation_id)
  WHERE is_current AND status='APPROVED';

ALTER TABLE refills
  ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reminder_type text,
  ADD COLUMN IF NOT EXISTS reminder_event_key text;
ALTER TABLE refills DROP CONSTRAINT IF EXISTS refills_status_check;
ALTER TABLE refills ADD CONSTRAINT refills_status_check CHECK (status IN ('NOT_DUE','DUE_SOON','DUE','REVIEW_PENDING','ORDERED','CLOSED'));

ALTER TABLE dispatches DROP CONSTRAINT IF EXISTS dispatches_status_check;
ALTER TABLE dispatches ADD CONSTRAINT dispatches_status_check CHECK (status IN ('READY_FOR_DISPATCH','DISPATCHED','DELIVERED'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS source_refill_id uuid REFERENCES refills(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS acceptance_nonce text,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS acceptance_channel text,
  ADD COLUMN IF NOT EXISTS acceptance_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtotal numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'NOT_STARTED';

UPDATE orders o
SET source_refill_id=r.id
FROM refills r
WHERE r.next_order_id=o.id AND o.source_refill_id IS NULL;

UPDATE orders
SET subtotal=COALESCE(amount, 0),
    amount=COALESCE(amount, 0),
    payment_status=CASE WHEN status='DELIVERED' THEN 'LEGACY_UNKNOWN' ELSE 'REVIEW_REQUIRED' END,
    status=CASE WHEN status='CONFIRMED' THEN 'PAYMENT_REVIEW_REQUIRED' ELSE status END;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_amounts_nonnegative;
ALTER TABLE orders ADD CONSTRAINT orders_amounts_nonnegative CHECK (
  subtotal >= 0 AND discount_amount >= 0 AND tax_amount >= 0 AND shipping_amount >= 0 AND amount >= 0
);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_total_matches;
ALTER TABLE orders ADD CONSTRAINT orders_total_matches CHECK (amount = subtotal - discount_amount + tax_amount + shipping_amount);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'AWAITING_ACCEPTANCE', 'AWAITING_PAYMENT', 'PAYMENT_PENDING', 'PAID',
  'PAYMENT_REVIEW_REQUIRED', 'IN_PRODUCTION', 'READY_TO_DISPATCH',
  'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'
));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN (
  'NOT_STARTED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED',
  'REVIEW_REQUIRED', 'LEGACY_UNKNOWN'
));
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_initial_per_recommendation
  ON orders(recommendation_id)
  WHERE source_refill_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_per_refill
  ON orders(source_refill_id)
  WHERE source_refill_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_acceptance_nonce
  ON orders(acceptance_nonce)
  WHERE acceptance_nonce IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_intents (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  provider text NOT NULL,
  provider_reference text,
  status text NOT NULL DEFAULT 'PENDING',
  amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  payment_url text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  CHECK (amount > 0),
  CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'))
);
CREATE INDEX IF NOT EXISTS idx_payment_intents_order ON payment_intents(order_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_one_pending
  ON payment_intents(order_id)
  WHERE status='PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_provider_reference
  ON payment_intents(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  payment_intent_id uuid REFERENCES payment_intents(id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_payload_purged_at timestamptz,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_event_id)
);

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS correlation_id text,
  ADD COLUMN IF NOT EXISTS prior_state text,
  ADD COLUMN IF NOT EXISTS resulting_state text,
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN IF NOT EXISTS ip_hash text;
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation ON audit_events(correlation_id);

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  request_type text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  handled_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  notes text,
  verified_at timestamptz,
  verification_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (request_type IN ('ACCESS', 'CORRECTION', 'ANONYMIZATION')),
  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_consultations_cursor ON consultations(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_cursor ON orders(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_cursor ON whatsapp_conversations(last_message_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS idx_customers_name_search ON customers(lower(name), id);
CREATE INDEX IF NOT EXISTS idx_customers_phone_search ON customers(phone, id);
CREATE INDEX IF NOT EXISTS idx_orders_public_id_search ON orders(public_id, id);
CREATE INDEX IF NOT EXISTS idx_consultations_folio_search ON consultations(folio_id, id);
