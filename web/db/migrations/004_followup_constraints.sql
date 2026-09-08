CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_activity_cursor
  ON whatsapp_conversations((COALESCE(last_message_at,created_at)) DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_activity_cursor
  ON whatsapp_messages(conversation_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_data_subject_requests_status ON data_subject_requests(status,requested_at DESC);

ALTER TABLE review_cases DROP CONSTRAINT IF EXISTS review_cases_status_check;
ALTER TABLE review_cases ADD CONSTRAINT review_cases_status_check CHECK (status IN (
  'NEW','CLARIFICATION_PENDING','CLARIFICATION_REQUIRED','ON_HOLD',
  'READY_FOR_RECOMMENDATION','APPROVED','CLOSED'
));

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_fulfillment_link;
ALTER TABLE order_items ADD CONSTRAINT order_items_fulfillment_link CHECK (
  (product_id IS NOT NULL AND formula_id IS NULL)
  OR (product_id IS NULL AND formula_id IS NOT NULL)
);

ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_personalised_link;
ALTER TABLE batches ADD CONSTRAINT batches_personalised_link CHECK (formula_id IS NOT NULL AND product_id IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_items_one_inventory_item
  ON batch_items(batch_id,inventory_item_id);

ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_type_check;
ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_type_check CHECK (
  transaction_type IN ('RECEIPT','ADJUSTMENT','BATCH_ISSUE','ORDER_ISSUE')
);

ALTER TABLE refills DROP CONSTRAINT IF EXISTS refills_decision_check;
ALTER TABLE refills ADD CONSTRAINT refills_decision_check CHECK (
  decision IS NULL OR decision IN ('SAME','MODIFY','STOP','CUSTOMER_REQUESTED')
);

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_outcome_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_outcome_check CHECK (outcome IN ('SUCCESS','REJECTED','FAILED'));
