-- OCR / AI image intake: batches, stored files, extracted rows, link to import_batches.
-- Safe additive DDL + views. No changes to voter_petition_signatures creation path here.

BEGIN;

CREATE TABLE IF NOT EXISTS ocr_image_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_key text NOT NULL,
  petition_id uuid NULL REFERENCES petitions (id) ON DELETE SET NULL,
  petition_code text NOT NULL,
  source_label text NULL,
  original_file_name text NOT NULL,
  file_hash text NOT NULL,
  mime_type text NOT NULL,
  file_size bigint NULL,
  image_count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'UPLOADED',
  ocr_model text NULL,
  ocr_started_at timestamptz NULL,
  ocr_completed_at timestamptz NULL,
  human_review_status text NOT NULL DEFAULT 'NEEDS_REVIEW',
  created_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS ocr_image_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ocr_image_batch_id uuid NOT NULL REFERENCES ocr_image_batches (id) ON DELETE CASCADE,
  original_file_name text NOT NULL,
  stored_file_path text NULL,
  file_hash text NOT NULL,
  mime_type text NOT NULL,
  file_size bigint NULL,
  width integer NULL,
  height integer NULL,
  page_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS ocr_extracted_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ocr_image_batch_id uuid NOT NULL REFERENCES ocr_image_batches (id) ON DELETE CASCADE,
  ocr_image_file_id uuid NULL REFERENCES ocr_image_files (id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  extraction_confidence_pct integer NULL,
  needs_human_review boolean NOT NULL DEFAULT true,
  human_review_status text NOT NULL DEFAULT 'NEEDS_REVIEW',
  first_name text NULL,
  last_name text NULL,
  full_name text NULL,
  birth_month text NULL,
  birth_day text NULL,
  birth_year text NULL,
  address text NULL,
  city text NULL,
  state text NULL,
  zip text NULL,
  signed_at text NULL,
  notes text NULL,
  uncertain_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_line_text text NULL,
  raw_extraction_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  qa_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  corrected_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  corrected_by text NULL,
  corrected_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS ocr_to_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ocr_image_batch_id uuid NOT NULL REFERENCES ocr_image_batches (id) ON DELETE CASCADE,
  import_batch_id uuid NULL REFERENCES import_batches (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ocr_image_batches_petition_code_idx ON ocr_image_batches (petition_code);
CREATE INDEX IF NOT EXISTS ocr_image_batches_status_idx ON ocr_image_batches (status);
CREATE INDEX IF NOT EXISTS ocr_image_batches_human_review_status_idx ON ocr_image_batches (human_review_status);
CREATE INDEX IF NOT EXISTS ocr_image_batches_file_hash_idx ON ocr_image_batches (file_hash);
CREATE INDEX IF NOT EXISTS ocr_image_files_batch_idx ON ocr_image_files (ocr_image_batch_id);
CREATE INDEX IF NOT EXISTS ocr_extracted_rows_batch_idx ON ocr_extracted_rows (ocr_image_batch_id);
CREATE INDEX IF NOT EXISTS ocr_extracted_rows_human_review_status_idx ON ocr_extracted_rows (human_review_status);
CREATE INDEX IF NOT EXISTS ocr_extracted_rows_needs_human_review_idx ON ocr_extracted_rows (needs_human_review);
CREATE INDEX IF NOT EXISTS ocr_to_import_batches_ocr_batch_idx ON ocr_to_import_batches (ocr_image_batch_id);
CREATE INDEX IF NOT EXISTS ocr_to_import_batches_import_batch_idx ON ocr_to_import_batches (import_batch_id);

COMMIT;

CREATE OR REPLACE VIEW ocr_batch_summary AS
SELECT
  b.id AS batch_id,
  b.petition_code,
  b.original_file_name,
  b.status,
  b.human_review_status,
  COUNT(r.id)::bigint AS total_extracted_rows,
  COUNT(r.id) FILTER (WHERE r.human_review_status = 'CONFIRMED')::bigint AS confirmed_rows,
  COUNT(r.id) FILTER (WHERE r.human_review_status = 'EDITED')::bigint AS edited_rows,
  COUNT(r.id) FILTER (WHERE r.human_review_status = 'REJECTED')::bigint AS rejected_rows,
  ROUND(AVG(r.extraction_confidence_pct)::numeric, 1) AS avg_extraction_confidence_pct,
  b.created_at
FROM ocr_image_batches b
LEFT JOIN ocr_extracted_rows r ON r.ocr_image_batch_id = b.id
GROUP BY b.id, b.petition_code, b.original_file_name, b.status, b.human_review_status, b.created_at;

CREATE OR REPLACE VIEW ocr_rows_needing_review AS
SELECT r.*
FROM ocr_extracted_rows r
WHERE r.needs_human_review = true
  AND r.human_review_status IN ('NEEDS_REVIEW', 'EDITED');
