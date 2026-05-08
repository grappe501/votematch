-- =============================================================================
-- TEMPLATE ONLY — optional indexes for a MATERIALIZED VIEW or TABLE copy of
-- voter_match_source. Do NOT create btree indexes on a plain PostgreSQL VIEW
-- (not supported). If you REFRESH a materialized view or ETL into a table, run
-- the relevant statements there instead.
-- =============================================================================

-- Example (materialized view or table named voter_match_source_mv):

-- CREATE UNIQUE INDEX IF NOT EXISTS voter_match_source_mv_voter_id_uq
--   ON public.voter_match_source_mv (voter_id);

-- CREATE INDEX IF NOT EXISTS voter_match_source_mv_name_idx
--   ON public.voter_match_source_mv (first_name_norm, last_name_norm);

-- CREATE INDEX IF NOT EXISTS voter_match_source_mv_name_dob_idx
--   ON public.voter_match_source_mv (first_name_norm, last_name_norm, birth_date);

-- CREATE INDEX IF NOT EXISTS voter_match_source_mv_name_yob_idx
--   ON public.voter_match_source_mv (first_name_norm, last_name_norm, birth_year);

-- CREATE INDEX IF NOT EXISTS voter_match_source_mv_city_norm_idx
--   ON public.voter_match_source_mv (city_norm);

-- CREATE INDEX IF NOT EXISTS voter_match_source_mv_zip5_idx
--   ON public.voter_match_source_mv (zip5);

-- CREATE INDEX IF NOT EXISTS voter_match_source_mv_address_norm_idx
--   ON public.voter_match_source_mv (address_norm);
