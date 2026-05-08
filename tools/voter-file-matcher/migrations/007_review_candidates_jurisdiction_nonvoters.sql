-- Review queue (threshold), jurisdiction metadata, candidate snapshots, nonvoter entries.
-- Safe additive DDL + new tables + OR REPLACE views.

BEGIN;

ALTER TABLE petitions ADD COLUMN IF NOT EXISTS jurisdiction_name text NULL;
ALTER TABLE petitions ADD COLUMN IF NOT EXISTS jurisdiction_city text NULL;
ALTER TABLE petitions ADD COLUMN IF NOT EXISTS jurisdiction_county text NULL;
ALTER TABLE petitions ADD COLUMN IF NOT EXISTS jurisdiction_state text NULL;
ALTER TABLE petitions ADD COLUMN IF NOT EXISTS jurisdiction_type text NULL;
ALTER TABLE petitions ADD COLUMN IF NOT EXISTS review_confidence_threshold integer NOT NULL DEFAULT 80;

ALTER TABLE import_voter_matches ADD COLUMN IF NOT EXISTS is_in_review_queue boolean NOT NULL DEFAULT false;
ALTER TABLE import_voter_matches ADD COLUMN IF NOT EXISTS review_priority integer NULL;
ALTER TABLE import_voter_matches ADD COLUMN IF NOT EXISTS jurisdiction_status text NULL;
ALTER TABLE import_voter_matches ADD COLUMN IF NOT EXISTS duplicate_status text NULL;
ALTER TABLE import_voter_matches ADD COLUMN IF NOT EXISTS candidate_page integer NOT NULL DEFAULT 0;
ALTER TABLE import_voter_matches ADD COLUMN IF NOT EXISTS candidate_search_offset integer NOT NULL DEFAULT 0;

ALTER TABLE voter_petition_signatures ADD COLUMN IF NOT EXISTS jurisdiction_status text NULL;
ALTER TABLE voter_petition_signatures ADD COLUMN IF NOT EXISTS duplicate_status text NULL;

CREATE TABLE IF NOT EXISTS initiative_nonvoter_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  petition_id uuid NOT NULL REFERENCES petitions (id) ON DELETE CASCADE,
  petition_code text NOT NULL,
  import_batch_id uuid NULL REFERENCES import_batches (id) ON DELETE SET NULL,
  import_row_id uuid NULL REFERENCES import_rows (id) ON DELETE SET NULL,
  import_voter_match_id uuid NULL REFERENCES import_voter_matches (id) ON DELETE SET NULL,
  source_file_name text NULL,
  row_number integer NULL,
  signer_first_name text NULL,
  signer_last_name text NULL,
  signer_full_name text NULL,
  signer_address text NULL,
  signer_city text NULL,
  signer_county text NULL,
  signer_state text NULL,
  signer_zip text NULL,
  signed_at date NULL,
  reason text NOT NULL DEFAULT 'NO_MATCH_FOUND',
  reviewed_by text NULL,
  reviewed_at timestamptz NULL DEFAULT now(),
  review_note text NULL,
  raw_row_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS initiative_nonvoter_entries_petition_code_idx ON initiative_nonvoter_entries (petition_code);
CREATE INDEX IF NOT EXISTS initiative_nonvoter_entries_petition_id_idx ON initiative_nonvoter_entries (petition_id);
CREATE INDEX IF NOT EXISTS initiative_nonvoter_entries_import_batch_id_idx ON initiative_nonvoter_entries (import_batch_id);
CREATE INDEX IF NOT EXISTS initiative_nonvoter_entries_import_row_id_idx ON initiative_nonvoter_entries (import_row_id);
CREATE INDEX IF NOT EXISTS initiative_nonvoter_entries_signer_last_name_idx ON initiative_nonvoter_entries (signer_last_name);
CREATE INDEX IF NOT EXISTS initiative_nonvoter_entries_signer_city_idx ON initiative_nonvoter_entries (signer_city);
CREATE INDEX IF NOT EXISTS initiative_nonvoter_entries_signer_zip_idx ON initiative_nonvoter_entries (signer_zip);

CREATE TABLE IF NOT EXISTS review_candidate_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id uuid NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  import_row_id uuid NOT NULL REFERENCES import_rows (id) ON DELETE CASCADE,
  import_voter_match_id uuid NULL REFERENCES import_voter_matches (id) ON DELETE SET NULL,
  candidate_rank integer NOT NULL,
  candidate_page integer NOT NULL DEFAULT 0,
  voter_id text NOT NULL,
  candidate_score integer NOT NULL,
  candidate_reason text NULL,
  first_name text NULL,
  last_name text NULL,
  birth_year integer NULL,
  birth_date date NULL,
  address text NULL,
  city text NULL,
  county text NULL,
  state text NULL,
  zip5 text NULL,
  ward text NULL,
  precinct text NULL,
  jurisdiction_status text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS review_candidate_snapshots_batch_row_idx ON review_candidate_snapshots (import_batch_id, import_row_id);
CREATE INDEX IF NOT EXISTS review_candidate_snapshots_match_idx ON review_candidate_snapshots (import_voter_match_id);
CREATE INDEX IF NOT EXISTS review_candidate_snapshots_voter_id_idx ON review_candidate_snapshots (voter_id);
CREATE INDEX IF NOT EXISTS review_candidate_snapshots_score_idx ON review_candidate_snapshots (candidate_score);

COMMIT;

-- Operator queue: open review rows that need attention under initiative threshold and quality rules.
CREATE OR REPLACE VIEW initiative_review_queue_80 AS
SELECT
  b.petition_code,
  p.petition_name,
  p.initiative_scope,
  p.jurisdiction_name,
  p.jurisdiction_city,
  p.jurisdiction_county,
  p.jurisdiction_state,
  p.jurisdiction_type,
  p.review_confidence_threshold,
  b.id AS import_batch_id,
  ir.row_number,
  ir.chunk_number,
  ir.id AS import_row_id,
  ir.normalized_json,
  ir.raw_json,
  mr.id AS import_voter_match_id,
  mr.match_status::text AS match_status,
  mr.match_confidence_pct,
  mr.review_status::text AS review_status,
  mr.jurisdiction_status,
  mr.duplicate_status,
  mr.candidate_count,
  COALESCE(ir.normalized_json->'_qa_flags', '[]'::jsonb) AS qa_flags,
  ir.normalized_json->>'first_name' AS signer_first_name,
  ir.normalized_json->>'last_name' AS signer_last_name,
  ir.normalized_json->>'full_name' AS signer_full_name,
  COALESCE(ir.normalized_json->>'address_line_display', ir.normalized_json->>'address') AS signer_address,
  ir.normalized_json->>'city' AS signer_city,
  ir.normalized_json->>'county' AS signer_county,
  ir.normalized_json->>'state' AS signer_state,
  ir.normalized_json->>'zip' AS signer_zip,
  ir.normalized_json->>'signed_at' AS signed_at,
  mr.notes AS match_notes,
  mr.candidate_page,
  mr.candidate_search_offset
FROM import_voter_matches mr
INNER JOIN import_rows ir ON ir.id = mr.import_row_id
INNER JOIN import_batches b ON b.id = mr.import_batch_id
LEFT JOIN petitions p ON p.id = b.petition_id
WHERE mr.review_status IN ('UNREVIEWED', 'NEEDS_MORE_INFO')
  AND (
    mr.match_status::text <> 'MATCHED'
    OR COALESCE(mr.match_confidence_pct, 0) < COALESCE(p.review_confidence_threshold, 80)
    OR mr.jurisdiction_status IN ('OUT_OF_JURISDICTION', 'UNKNOWN_JURISDICTION', 'NOT_CHECKED')
    OR mr.duplicate_status IN ('DUPLICATE_WITHIN_FILE', 'DUPLICATE_EXISTING_SIGNATURE', 'POSSIBLE_DUPLICATE')
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(ir.normalized_json->'_qa_flags', '[]'::jsonb)) AS qaf(v)
      WHERE qaf.v IN (
        'MISSING_FIRST_NAME',
        'MISSING_LAST_NAME',
        'MISSING_ADDRESS',
        'INVALID_BIRTH_DATE',
        'INVALID_BIRTH_YEAR',
        'INVALID_ZIP'
      )
    )
  );

CREATE OR REPLACE VIEW initiative_nonvoter_summary AS
SELECT
  petition_code,
  COUNT(*)::bigint AS total_nonvoter_entries,
  COUNT(*) FILTER (WHERE signer_city IS NOT NULL AND btrim(signer_city) <> '')::bigint AS entries_with_city,
  COUNT(*) FILTER (WHERE signer_county IS NOT NULL AND btrim(signer_county) <> '')::bigint AS entries_with_county,
  COUNT(*) FILTER (WHERE signer_state IS NOT NULL AND btrim(signer_state) <> '')::bigint AS entries_with_state
FROM initiative_nonvoter_entries
GROUP BY petition_code;

CREATE OR REPLACE VIEW initiative_duplicate_summary AS
SELECT
  b.petition_code,
  mr.duplicate_status,
  COUNT(*)::bigint AS row_count
FROM import_voter_matches mr
INNER JOIN import_batches b ON b.id = mr.import_batch_id
WHERE mr.duplicate_status IS NOT NULL
GROUP BY b.petition_code, mr.duplicate_status;

-- Ward / county rollups: count signatures treated as in-jurisdiction (NULL legacy rows count as in).
CREATE OR REPLACE VIEW initiative_ward_counts AS
SELECT
  s.petition_code,
  COALESCE(NULLIF(btrim(s.voter_ward), ''), 'UNKNOWN') AS voter_ward,
  COUNT(*)::bigint AS total_signatures,
  ROUND(AVG(s.match_confidence_pct)::numeric, 1) AS avg_confidence_pct
FROM voter_petition_signatures s
WHERE COALESCE(s.jurisdiction_status, 'IN_JURISDICTION') = 'IN_JURISDICTION'
GROUP BY s.petition_code, COALESCE(NULLIF(btrim(s.voter_ward), ''), 'UNKNOWN');

CREATE OR REPLACE VIEW initiative_county_counts AS
SELECT
  s.petition_code,
  COALESCE(NULLIF(btrim(s.signer_county), ''), 'UNKNOWN') AS signer_county,
  COUNT(*)::bigint AS total_signatures,
  ROUND(AVG(s.match_confidence_pct)::numeric, 1) AS avg_confidence_pct
FROM voter_petition_signatures s
WHERE COALESCE(s.jurisdiction_status, 'IN_JURISDICTION') = 'IN_JURISDICTION'
GROUP BY s.petition_code, COALESCE(NULLIF(btrim(s.signer_county), ''), 'UNKNOWN');
