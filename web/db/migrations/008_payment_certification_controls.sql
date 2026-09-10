ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_status_check
  CHECK (status IN ('PENDING','PAID','FAILED','CANCELLED','REFUNDED','REVIEW_REQUIRED'));

ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS canonical_status text,
  ADD COLUMN IF NOT EXISTS processing_outcome text NOT NULL DEFAULT 'APPLIED',
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_note text;

ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_canonical_status_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_canonical_status_check
  CHECK (canonical_status IS NULL OR canonical_status IN ('PENDING','PAID','FAILED','CANCELLED','REFUNDED'));
ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_processing_outcome_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_processing_outcome_check
  CHECK (processing_outcome IN ('APPLIED','IGNORED_STALE','REVIEW_REQUIRED'));
CREATE INDEX IF NOT EXISTS idx_payment_events_unreviewed
  ON payment_events(processed_at DESC)
  WHERE processing_outcome='REVIEW_REQUIRED' AND reviewed_at IS NULL;

CREATE OR REPLACE FUNCTION enforce_paid_order_fulfillment() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('IN_PRODUCTION','READY_TO_DISPATCH','SHIPPED','DELIVERED')
     AND NEW.payment_status <> 'PAID' THEN
    IF TG_OP='UPDATE'
       AND OLD.status='DELIVERED' AND OLD.payment_status='LEGACY_UNKNOWN'
       AND NEW.status='DELIVERED' AND NEW.payment_status='LEGACY_UNKNOWN' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Order % cannot enter fulfilment without PAID payment status', NEW.id
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_require_paid_fulfillment ON orders;
CREATE TRIGGER trg_orders_require_paid_fulfillment
  BEFORE INSERT OR UPDATE OF status,payment_status ON orders
  FOR EACH ROW EXECUTE FUNCTION enforce_paid_order_fulfillment();
