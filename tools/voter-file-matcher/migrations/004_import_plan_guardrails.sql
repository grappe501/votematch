-- Import plan guardrails (optional migration for production import workflow).
-- Safe to apply after 001_import_matcher_tables.sql (requires import_batches).

CREATE TABLE IF NOT EXISTS public.import_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_key text NOT NULL UNIQUE,
  project_key text NOT NULL,
  petition_code text NOT NULL,
  petition_name text NULL,
  source_label text NULL,
  source_file_name text NOT NULL,
  source_file_hash text NOT NULL,
  source_file_size bigint NULL,
  source_profile_path text NULL,
  source_profile_name text NULL,
  map_path text NULL,
  match_source_mode text NULL,
  match_source_table text NULL,
  canonical_table text NULL,
  projected_matching_quality text NULL,
  row_count integer NULL,
  ready_for_import boolean NOT NULL DEFAULT false,
  preflight_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  readiness_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_probe_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  operator_review_status text NOT NULL DEFAULT 'DRAFT',
  operator_reviewed_by text NULL,
  operator_reviewed_at timestamptz NULL,
  operator_note text NULL,
  executed_import_batch_id uuid NULL REFERENCES public.import_batches (id) ON DELETE SET NULL,
  executed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS import_plans_project_key_idx ON public.import_plans (project_key);
CREATE INDEX IF NOT EXISTS import_plans_petition_code_idx ON public.import_plans (petition_code);
CREATE INDEX IF NOT EXISTS import_plans_source_file_hash_idx ON public.import_plans (source_file_hash);
CREATE INDEX IF NOT EXISTS import_plans_operator_review_status_idx ON public.import_plans (operator_review_status);
CREATE INDEX IF NOT EXISTS import_plans_executed_import_batch_id_idx ON public.import_plans (executed_import_batch_id);

COMMENT ON TABLE public.import_plans IS 'Guarded production import plans; CLI-only workflow — no row PII stored here.';
