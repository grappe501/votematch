-- Reporting and review views + optional geo columns on permanent signatures.
-- Safe to re-run: IF NOT EXISTS / OR REPLACE.

BEGIN;

ALTER TABLE voter_petition_signatures
  ADD COLUMN IF NOT EXISTS voter_ward text NULL;

ALTER TABLE voter_petition_signatures
  ADD COLUMN IF NOT EXISTS voter_precinct text NULL;

ALTER TABLE voter_petition_signatures
  ADD COLUMN IF NOT EXISTS voter_district text NULL;

CREATE INDEX IF NOT EXISTS voter_petition_signatures_voter_ward_idx ON voter_petition_signatures (voter_ward);

CREATE INDEX IF NOT EXISTS voter_petition_signatures_voter_precinct_idx ON voter_petition_signatures (voter_precinct);

CREATE INDEX IF NOT EXISTS voter_petition_signatures_voter_district_idx ON voter_petition_signatures (voter_district);

COMMIT;

-- One row per import_row + match (enriched for CSV/JSON reports).
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
  SELECT s.id, s.match_method, s.voter_ward, s.voter_precinct, s.voter_district
  FROM voter_petition_signatures s
  WHERE s.import_row_id = ir.id
  ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
  LIMIT 1
) sig ON true;

-- Operator queue: unresolved review rows that are not slam-dunk matches.
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

-- Rollup of attached signatures by petition + stored ward (UNKNOWN when null/blank).
CREATE OR REPLACE VIEW petition_ward_signature_counts AS
SELECT
  petition_code,
  COALESCE(NULLIF(btrim(voter_ward), ''), 'UNKNOWN') AS ward_label,
  COUNT(*)::bigint AS signature_count
FROM voter_petition_signatures
GROUP BY petition_code, COALESCE(NULLIF(btrim(voter_ward), ''), 'UNKNOWN');
