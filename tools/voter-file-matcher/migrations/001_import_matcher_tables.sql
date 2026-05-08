-- Voter import + petition signature matcher (public schema).
-- Run once per database. Re-run is safe: IF NOT EXISTS on tables; OR REPLACE on views.

BEGIN;

CREATE TABLE IF NOT EXISTS import_batches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_key    TEXT        NOT NULL,
  petition_id    UUID        NULL,
  petition_code  TEXT        NULL,
  source_label   TEXT        NULL,
  file_name      TEXT        NOT NULL,
  file_hash      TEXT        NULL,
  total_rows     INTEGER     NOT NULL DEFAULT 0,
  status         TEXT        NOT NULL DEFAULT 'PENDING',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ NULL,
  created_by     TEXT        NULL,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS import_batches_project_key_idx ON import_batches (project_key);
CREATE INDEX IF NOT EXISTS import_batches_petition_id_idx ON import_batches (petition_id);
CREATE INDEX IF NOT EXISTS import_batches_created_at_idx ON import_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS import_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  file_name       TEXT NOT NULL,
  file_hash       TEXT NULL,
  mime_type       TEXT NULL,
  row_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS import_files_batch_idx ON import_files (import_batch_id);

CREATE TABLE IF NOT EXISTS import_header_maps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  project_key     TEXT NOT NULL,
  map_name        TEXT NULL,
  header_map      JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_header_maps_batch_idx ON import_header_maps (import_batch_id);

CREATE TABLE IF NOT EXISTS import_rows (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id   UUID NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  row_number          INTEGER NOT NULL,
  chunk_number        INTEGER NOT NULL,
  raw_json            JSONB NOT NULL,
  normalized_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_rows_batch_idx ON import_rows (import_batch_id);
CREATE INDEX IF NOT EXISTS import_rows_batch_chunk_idx ON import_rows (import_batch_id, chunk_number);
CREATE INDEX IF NOT EXISTS import_rows_normalized_gin ON import_rows USING gin (normalized_json);

CREATE TABLE IF NOT EXISTS import_voter_matches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id     UUID NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  import_row_id       UUID NOT NULL REFERENCES import_rows (id) ON DELETE CASCADE,
  voter_id            TEXT NULL,
  match_status        TEXT NOT NULL,
  match_confidence    NUMERIC NULL,
  match_method        TEXT NULL,
  candidate_count     INTEGER NOT NULL DEFAULT 0,
  candidate_voter_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes               TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT import_voter_matches_status_chk CHECK (
    match_status IN ('MATCHED', 'NOT_FOUND', 'MULTIPLE_MATCHES', 'WEAK_MATCH', 'ERROR')
  )
);

CREATE INDEX IF NOT EXISTS import_voter_matches_batch_idx ON import_voter_matches (import_batch_id);
CREATE INDEX IF NOT EXISTS import_voter_matches_row_idx ON import_voter_matches (import_row_id);
CREATE INDEX IF NOT EXISTS import_voter_matches_voter_idx ON import_voter_matches (voter_id);
CREATE INDEX IF NOT EXISTS import_voter_matches_status_idx ON import_voter_matches (match_status);

CREATE TABLE IF NOT EXISTS petitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  petition_code   TEXT NOT NULL,
  petition_name   TEXT NOT NULL,
  petition_type   TEXT NULL,
  jurisdiction    TEXT NULL,
  default_city    TEXT NULL,
  default_county  TEXT NULL,
  project_key     TEXT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT petitions_code_unique UNIQUE (petition_code)
);

CREATE TABLE IF NOT EXISTS voter_petition_signatures (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voter_id             TEXT NOT NULL,
  petition_id          UUID NOT NULL REFERENCES petitions (id) ON DELETE CASCADE,
  petition_code        TEXT NOT NULL,
  import_batch_id      UUID NULL REFERENCES import_batches (id) ON DELETE SET NULL,
  import_row_id        UUID NULL REFERENCES import_rows (id) ON DELETE SET NULL,
  source_project_key   TEXT NULL,
  source_label         TEXT NULL,
  source_file_name     TEXT NULL,
  signature_status     TEXT NOT NULL DEFAULT 'SIGNED',
  signed_at            DATE NULL,
  signer_first_name    TEXT NULL,
  signer_last_name     TEXT NULL,
  signer_full_name     TEXT NULL,
  signer_address       TEXT NULL,
  signer_city          TEXT NULL,
  signer_county        TEXT NULL,
  signer_state         TEXT NULL,
  signer_zip           TEXT NULL,
  raw_row_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  match_method         TEXT NULL,
  match_confidence     NUMERIC NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT voter_petition_signatures_voter_petition_unique UNIQUE (voter_id, petition_id)
);

CREATE INDEX IF NOT EXISTS voter_petition_signatures_voter_idx ON voter_petition_signatures (voter_id);
CREATE INDEX IF NOT EXISTS voter_petition_signatures_petition_idx ON voter_petition_signatures (petition_id);
CREATE INDEX IF NOT EXISTS voter_petition_signatures_code_idx ON voter_petition_signatures (petition_code);
CREATE INDEX IF NOT EXISTS voter_petition_signatures_city_idx ON voter_petition_signatures (signer_city);
CREATE INDEX IF NOT EXISTS voter_petition_signatures_county_idx ON voter_petition_signatures (signer_county);
CREATE INDEX IF NOT EXISTS voter_petition_signatures_status_idx ON voter_petition_signatures (signature_status);
CREATE INDEX IF NOT EXISTS voter_petition_signatures_norm_gin ON voter_petition_signatures USING gin (normalized_json);

CREATE TABLE IF NOT EXISTS import_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  report_type     TEXT NOT NULL,
  report_json     JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_reports_batch_idx ON import_reports (import_batch_id);

COMMIT;

CREATE OR REPLACE VIEW voter_petition_signature_summary AS
SELECT
  voter_id,
  COUNT(*)::bigint AS petition_count,
  array_agg(DISTINCT petition_code ORDER BY petition_code) AS petition_codes,
  MAX(created_at) AS latest_signature_at
FROM voter_petition_signatures
GROUP BY voter_id;

CREATE OR REPLACE VIEW petition_signature_counts AS
SELECT
  p.id AS petition_id,
  p.petition_code,
  p.petition_name,
  (SELECT COUNT(*)::bigint FROM voter_petition_signatures s WHERE s.petition_id = p.id) AS total_signers,
  COALESCE(
    (
      SELECT jsonb_object_agg(city_key, cnt)
      FROM (
        SELECT
          COALESCE(NULLIF(btrim(s.signer_city), ''), '(unknown)') AS city_key,
          COUNT(*)::int AS cnt
        FROM voter_petition_signatures s
        WHERE s.petition_id = p.id
        GROUP BY 1
      ) c
    ),
    '{}'::jsonb
  ) AS signers_by_city,
  COALESCE(
    (
      SELECT jsonb_object_agg(co_key, cnt)
      FROM (
        SELECT
          COALESCE(NULLIF(btrim(s.signer_county), ''), '(unknown)') AS co_key,
          COUNT(*)::int AS cnt
        FROM voter_petition_signatures s
        WHERE s.petition_id = p.id
        GROUP BY 1
      ) d
    ),
    '{}'::jsonb
  ) AS signers_by_county
FROM petitions p;

CREATE OR REPLACE VIEW jacksonville_petition_signers AS
SELECT *
FROM voter_petition_signatures
WHERE lower(btrim(COALESCE(signer_city, ''))) = 'jacksonville';
