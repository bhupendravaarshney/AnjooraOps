CREATE INDEX IF NOT EXISTS idx_batches_cursor
  ON batches(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_refills_due_cursor
  ON refills(due_date, id);

CREATE INDEX IF NOT EXISTS idx_inventory_items_cursor
  ON inventory_items(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_products_cursor
  ON products(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_data_subject_requests_cursor
  ON data_subject_requests(requested_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_dispatches_awb
  ON dispatches(awb)
  WHERE awb IS NOT NULL;
