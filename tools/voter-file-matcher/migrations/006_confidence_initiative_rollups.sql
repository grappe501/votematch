-- Match confidence % (0–100), initiative metadata on petitions, and rollup views.
-- Safe additive DDL + OR REPLACE views.

BEGIN;

ALTER TABLE import_voter_matches
  ADD COLUMN IF NOT EXISTS match_confidence_pct integer NULL;

ALTER TABLE voter_petition_signatures
  ADD COLUMN IF NOT EXISTS match_confidence_pct integer NULL;

CREATE INDEX IF NOT EXISTS import_voter_matches_match_confidence_pct_idx ON import_voter_matches (match_confidence_pct);

CREATE INDEX IF NOT EXISTS voter_petition_signatures_match_confidence_pct_idx ON voter_petition_signatures (match_confidence_pct);

ALTER TABLE petitions
  ADD COLUMN IF NOT EXISTS initiative_scope text NULL;

ALTER TABLE petitions
  ADD COLUMN IF NOT EXISTS reporting_geo text NULL;

ALTER TABLE petitions
  ADD COLUMN IF NOT EXISTS target_signature_count integer NULL;

ALTER TABLE petitions
  ADD COLUMN IF NOT EXISTS notes text NULL;

COMMIT;

-- Enriched reporting row (includes integer confidence %).
CREATE OR REPLACE VIEW batch_signature_report_rows AS
SELECT
  b.id AS import_batch_id,
  b.petition_code,
  b.petition_id,
  p.petition_name,
  ir.id AS import_row_id,
  mr.id AS import_voter_match_id,
  ir.row_number,
  ir.chunk_number,
  mr.match_status::text AS match_status,
  mr.review_status::text AS review_status,
  mr.voter_id,
  mr.resolved_voter_id,
  mr.candidate_count,
  mr.candidate_voter_ids,
  mr.match_method,
  mr.match_confidence,
  mr.match_confidence_pct,
  ir.raw_json,
  ir.normalized_json,
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
  ir.normalized_json->>'birth_month' AS birth_month,
  ir.normalized_json->>'birth_day' AS birth_day,
  ir.normalized_json->>'birth_year' AS birth_year,
  ir.normalized_json->>'birth_date' AS birth_date,
  mr.notes,
  b.file_name AS source_file_name,
  b.created_at::text AS batch_created_at,
  sig.id AS voter_petition_signature_id,
  sig.match_method AS signature_match_method,
  sig.match_confidence_pct AS signature_match_confidence_pct,
  sig.voter_ward AS signature_voter_ward,
  sig.voter_precinct AS signature_voter_precinct,
  sig.voter_district AS signature_voter_district,
  mr.reviewed_by,
  mr.reviewed_at::text AS reviewed_at,
  mr.resolution_note
FROM import_batches b
INNER JOIN import_rows ir ON ir.import_batch_id = b.id
INNER JOIN import_voter_matches mr ON mr.import_row_id = ir.id AND mr.import_batch_id = b.id
LEFT JOIN petitions p ON p.id = b.petition_id
LEFT JOIN LATERAL (
  SELECT s.id, s.match_method, s.match_confidence_pct, s.voter_ward, s.voter_precinct, s.voter_district
  FROM voter_petition_signatures s
  WHERE s.import_row_id = ir.id
  ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
  LIMIT 1
) sig ON true;

CREATE OR REPLACE VIEW batch_review_queue_enriched AS
SELECT bsr.*
FROM batch_signature_report_rows bsr
WHERE bsr.review_status IN ('UNREVIEWED', 'NEEDS_MORE_INFO')
  AND (
    bsr.match_status IN ('NOT_FOUND', 'MULTIPLE_MATCHES', 'WEAK_MATCH', 'ERROR')
    OR (
      bsr.match_status = 'MATCHED'
      AND (
        bsr.candidate_count IS DISTINCT FROM 1
        OR bsr.voter_id IS NULL
        OR (bsr.match_confidence IS NOT NULL AND bsr.match_confidence < 0.95::numeric)
        OR (
          bsr.match_confidence IS NULL
          AND (
            lower(coalesce(bsr.match_method, '')) LIKE '%weak%'
            OR lower(coalesce(bsr.match_method, '')) LIKE '%tier5%'
          )
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(bsr.qa_flags, '[]'::jsonb)) AS qaf(v)
          WHERE qaf.v IN (
            'MISSING_FIRST_NAME',
            'MISSING_LAST_NAME',
            'MISSING_ADDRESS',
            'INVALID_BIRTH_DATE',
            'INVALID_BIRTH_YEAR',
            'INVALID_ZIP',
            'FUTURE_SIGNED_AT'
          )
        )
      )
    )
  );

CREATE OR REPLACE VIEW petition_ward_signature_counts AS
SELECT
  petition_code,
  COALESCE(NULLIF(btrim(voter_ward), ''), 'UNKNOWN') AS ward_label,
  COUNT(*)::bigint AS signature_count
FROM voter_petition_signatures
GROUP BY petition_code, COALESCE(NULLIF(btrim(voter_ward), ''), 'UNKNOWN');

CREATE OR REPLACE VIEW initiative_signature_rollup AS
SELECT
  p.id AS petition_id,
  p.petition_code,
  p.petition_name,
  p.initiative_scope,
  p.reporting_geo,
  COUNT(s.id)::bigint AS total_signatures,
  COUNT(s.id) FILTER (
    WHERE s.match_confidence_pct IS NOT NULL
      AND s.match_confidence_pct >= 100
      AND (s.match_method IS DISTINCT FROM 'MANUAL_REVIEW_APPROVE')
  )::bigint AS auto_matched_signatures,
  COUNT(s.id) FILTER (WHERE s.match_method = 'MANUAL_REVIEW_APPROVE')::bigint AS manually_approved_signatures,
  ROUND(AVG(s.match_confidence_pct)::numeric, 1) AS avg_confidence_pct,
  MAX(s.match_confidence_pct) AS max_confidence_pct,
  MIN(s.match_confidence_pct) AS min_confidence_pct,
  MIN(s.created_at) AS first_signature_at,
  MAX(s.updated_at) AS latest_signature_at
FROM petitions p
LEFT JOIN voter_petition_signatures s ON s.petition_id = p.id
GROUP BY p.id, p.petition_code, p.petition_name, p.initiative_scope, p.reporting_geo;

CREATE OR REPLACE VIEW initiative_ward_counts AS
SELECT
  s.petition_code,
  COALESCE(NULLIF(btrim(s.voter_ward), ''), 'UNKNOWN') AS voter_ward,
  COUNT(*)::bigint AS total_signatures,
  ROUND(AVG(s.match_confidence_pct)::numeric, 1) AS avg_confidence_pct
FROM voter_petition_signatures s
GROUP BY s.petition_code, COALESCE(NULLIF(btrim(s.voter_ward), ''), 'UNKNOWN');

CREATE OR REPLACE VIEW initiative_county_counts AS
SELECT
  s.petition_code,
  COALESCE(NULLIF(btrim(s.signer_county), ''), 'UNKNOWN') AS signer_county,
  COUNT(*)::bigint AS total_signatures,
  ROUND(AVG(s.match_confidence_pct)::numeric, 1) AS avg_confidence_pct
FROM voter_petition_signatures s
GROUP BY s.petition_code, COALESCE(NULLIF(btrim(s.signer_county), ''), 'UNKNOWN');

CREATE OR REPLACE VIEW initiative_review_confidence_queue AS
SELECT
  b.petition_code,
  p.petition_name,
  p.initiative_scope,
  p.reporting_geo,
  mr.match_confidence_pct,
  mr.match_status::text AS match_status,
  mr.review_status::text AS review_status,
  ir.row_number,
  ir.chunk_number,
  ir.normalized_json,
  mr.candidate_count,
  mr.candidate_voter_ids,
  mr.match_method,
  mr.match_confidence,
  mr.notes,
  mr.id AS import_voter_match_id,
  b.id AS import_batch_id
FROM import_voter_matches mr
INNER JOIN import_rows ir ON ir.id = mr.import_row_id
INNER JOIN import_batches b ON b.id = mr.import_batch_id
LEFT JOIN petitions p ON p.id = b.petition_id
WHERE mr.review_status IN ('UNREVIEWED', 'NEEDS_MORE_INFO')
  AND (
    mr.match_status IN ('NOT_FOUND', 'MULTIPLE_MATCHES', 'WEAK_MATCH', 'ERROR')
    OR (
      mr.match_status = 'MATCHED'
      AND (
        mr.candidate_count IS DISTINCT FROM 1
        OR mr.voter_id IS NULL
        OR (mr.match_confidence IS NOT NULL AND mr.match_confidence < 0.95::numeric)
        OR (
          mr.match_confidence IS NULL
          AND (
            lower(coalesce(mr.match_method, '')) LIKE '%weak%'
            OR lower(coalesce(mr.match_method, '')) LIKE '%tier5%'
          )
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(ir.normalized_json->'_qa_flags', '[]'::jsonb)) AS qaf(v)
          WHERE qaf.v IN (
            'MISSING_FIRST_NAME',
            'MISSING_LAST_NAME',
            'MISSING_ADDRESS',
            'INVALID_BIRTH_DATE',
            'INVALID_BIRTH_YEAR',
            'INVALID_ZIP',
            'FUTURE_SIGNED_AT'
          )
        )
      )
    )
  );
