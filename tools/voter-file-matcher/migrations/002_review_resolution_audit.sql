-- Review queue, manual resolution audit, and permanent signature event log.
-- Safe after 001_import_matcher_tables.sql. Idempotent column adds + OR REPLACE views.

BEGIN;

-- 1) import_voter_matches: review state (no CHECK constraint on review_status per product note)
ALTER TABLE import_voter_matches
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'UNREVIEWED';

ALTER TABLE import_voter_matches
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz NULL;

ALTER TABLE import_voter_matches
  ADD COLUMN IF NOT EXISTS reviewed_by text NULL;

ALTER TABLE import_voter_matches
  ADD COLUMN IF NOT EXISTS resolved_voter_id text NULL;

ALTER TABLE import_voter_matches
  ADD COLUMN IF NOT EXISTS resolution_note text NULL;

ALTER TABLE import_voter_matches
  ADD COLUMN IF NOT EXISTS resolution_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS import_voter_matches_review_status_idx ON import_voter_matches (review_status);
CREATE INDEX IF NOT EXISTS import_voter_matches_resolved_voter_id_idx ON import_voter_matches (resolved_voter_id);
CREATE INDEX IF NOT EXISTS import_voter_matches_match_review_idx ON import_voter_matches (match_status, review_status);

-- 2) import_match_reviews: audit log of review actions (idempotent re-run)
CREATE TABLE IF NOT EXISTS import_match_reviews (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id         uuid NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  import_row_id           uuid NOT NULL REFERENCES import_rows (id) ON DELETE CASCADE,
  import_voter_match_id   uuid NULL REFERENCES import_voter_matches (id) ON DELETE SET NULL,
  action                  text NOT NULL,
  previous_match_status   text NULL,
  previous_review_status  text NULL,
  selected_voter_id       text NULL,
  selected_petition_id    uuid NULL,
  selected_petition_code  text NULL,
  reviewed_by             text NULL,
  review_note             text NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS import_match_reviews_batch_idx ON import_match_reviews (import_batch_id);
CREATE INDEX IF NOT EXISTS import_match_reviews_row_idx ON import_match_reviews (import_row_id);
CREATE INDEX IF NOT EXISTS import_match_reviews_match_idx ON import_match_reviews (import_voter_match_id);
CREATE INDEX IF NOT EXISTS import_match_reviews_action_idx ON import_match_reviews (action);
CREATE INDEX IF NOT EXISTS import_match_reviews_selected_voter_idx ON import_match_reviews (selected_voter_id);
CREATE INDEX IF NOT EXISTS import_match_reviews_created_at_idx ON import_match_reviews (created_at);

-- 3) voter_petition_signature_events: audit permanent signature writes (idempotent re-run)
CREATE TABLE IF NOT EXISTS voter_petition_signature_events (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voter_petition_signature_id uuid NULL REFERENCES voter_petition_signatures (id) ON DELETE SET NULL,
  voter_id                    text NOT NULL,
  petition_id                 uuid NOT NULL REFERENCES petitions (id) ON DELETE CASCADE,
  petition_code               text NOT NULL,
  import_batch_id             uuid NULL REFERENCES import_batches (id) ON DELETE SET NULL,
  import_row_id               uuid NULL REFERENCES import_rows (id) ON DELETE SET NULL,
  event_type                  text NOT NULL,
  actor                       text NULL,
  event_note                  text NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS voter_petition_signature_events_voter_idx ON voter_petition_signature_events (voter_id);
CREATE INDEX IF NOT EXISTS voter_petition_signature_events_petition_idx ON voter_petition_signature_events (petition_id);
CREATE INDEX IF NOT EXISTS voter_petition_signature_events_code_idx ON voter_petition_signature_events (petition_code);
CREATE INDEX IF NOT EXISTS voter_petition_signature_events_batch_idx ON voter_petition_signature_events (import_batch_id);
CREATE INDEX IF NOT EXISTS voter_petition_signature_events_type_idx ON voter_petition_signature_events (event_type);
CREATE INDEX IF NOT EXISTS voter_petition_signature_events_created_at_idx ON voter_petition_signature_events (created_at);

COMMIT;

-- 4) Views (outside transaction is fine for CREATE OR REPLACE VIEW)
CREATE OR REPLACE VIEW import_review_queue AS
SELECT
  mr.import_batch_id,
  mr.import_row_id,
  mr.id AS import_voter_match_id,
  ir.row_number,
  ir.chunk_number,
  b.project_key,
  b.petition_id,
  b.petition_code,
  b.file_name,
  mr.match_status,
  mr.review_status,
  mr.candidate_count,
  mr.candidate_voter_ids,
  ir.normalized_json,
  ir.raw_json,
  mr.notes,
  mr.created_at
FROM import_voter_matches mr
INNER JOIN import_rows ir ON ir.id = mr.import_row_id
INNER JOIN import_batches b ON b.id = mr.import_batch_id
WHERE mr.match_status IN ('MULTIPLE_MATCHES', 'WEAK_MATCH', 'NOT_FOUND', 'ERROR')
  AND mr.review_status IN ('UNREVIEWED', 'NEEDS_MORE_INFO');

CREATE OR REPLACE VIEW petition_signature_audit AS
SELECT
  s.id AS signature_id,
  s.voter_id,
  s.petition_id,
  s.petition_code,
  p.petition_name,
  s.signer_first_name,
  s.signer_last_name,
  s.signer_city,
  s.signer_county,
  s.signature_status,
  s.source_file_name,
  s.import_batch_id,
  s.created_at,
  s.updated_at,
  ev.last_event_type,
  ev.last_event_at
FROM voter_petition_signatures s
INNER JOIN petitions p ON p.id = s.petition_id
LEFT JOIN LATERAL (
  SELECT
    e.event_type AS last_event_type,
    e.created_at AS last_event_at
  FROM voter_petition_signature_events e
  WHERE e.voter_id = s.voter_id
    AND e.petition_id = s.petition_id
  ORDER BY e.created_at DESC
  LIMIT 1
) ev ON true;

CREATE OR REPLACE VIEW petition_city_counts AS
SELECT
  petition_code,
  COALESCE(NULLIF(btrim(signer_city), ''), '(unknown)') AS signer_city,
  COALESCE(NULLIF(btrim(signer_county), ''), '(unknown)') AS signer_county,
  COUNT(*)::bigint AS total_signers
FROM voter_petition_signatures
GROUP BY petition_code,
  COALESCE(NULLIF(btrim(signer_city), ''), '(unknown)'),
  COALESCE(NULLIF(btrim(signer_county), ''), '(unknown)');
