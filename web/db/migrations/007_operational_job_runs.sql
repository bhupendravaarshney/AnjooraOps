CREATE TABLE IF NOT EXISTS operational_job_runs (
  id uuid PRIMARY KEY,
  job_name text NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING',
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  duration_ms integer,
  CHECK (job_name IN ('outbox','refills','maintenance')),
  CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CHECK (
    (status='RUNNING' AND completed_at IS NULL)
    OR (status IN ('SUCCEEDED','FAILED') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_operational_job_runs_latest
  ON operational_job_runs(job_name,started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_operational_job_runs_status
  ON operational_job_runs(status,started_at DESC);
