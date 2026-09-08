ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS safety_review_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS urgent_safety_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS safety_screen_version text;

CREATE TABLE IF NOT EXISTS consultation_concerns (
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  concern_key text NOT NULL,
  concern_label text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  position smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consultation_id, concern_key),
  UNIQUE (consultation_id, position),
  CHECK (char_length(concern_key) BETWEEN 1 AND 64),
  CHECK (char_length(concern_label) BETWEEN 1 AND 80),
  CHECK (position BETWEEN 1 AND 4)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_consultation_concerns_one_primary
  ON consultation_concerns(consultation_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS idx_consultation_concerns_key
  ON consultation_concerns(concern_key, consultation_id);

CREATE TABLE IF NOT EXISTS consultation_safety_flags (
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  flag_code text NOT NULL,
  flag_label text NOT NULL,
  severity text NOT NULL,
  position smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consultation_id, flag_code),
  UNIQUE (consultation_id, position),
  CHECK (severity IN ('CLEAR', 'REVIEW', 'URGENT')),
  CHECK (char_length(flag_code) BETWEEN 1 AND 64),
  CHECK (char_length(flag_label) BETWEEN 1 AND 160),
  CHECK (position BETWEEN 1 AND 8)
);

CREATE INDEX IF NOT EXISTS idx_consultation_safety_flags_code
  ON consultation_safety_flags(flag_code, consultation_id);

INSERT INTO consultation_concerns (
  consultation_id,
  concern_key,
  concern_label,
  is_primary,
  position
)
SELECT
  c.id,
  COALESCE(
    NULLIF(
      trim(BOTH '-' FROM lower(regexp_replace(trim(c.concern), '[^a-zA-Z0-9]+', '-', 'g'))),
      ''
    ),
    'legacy-' || substr(md5(c.concern), 1, 12)
  ),
  c.concern,
  true,
  1
FROM consultations c
WHERE NOT EXISTS (
  SELECT 1
  FROM consultation_concerns cc
  WHERE cc.consultation_id = c.id
);

INSERT INTO consultation_safety_flags (
  consultation_id,
  flag_code,
  flag_label,
  severity,
  position
)
SELECT
  c.id,
  'not-provided',
  'Safety screen was not captured for this legacy consultation',
  'REVIEW',
  1
FROM consultations c
WHERE NOT EXISTS (
  SELECT 1
  FROM consultation_safety_flags csf
  WHERE csf.consultation_id = c.id
);

