-- =============================================================================
-- TEMPLATE ONLY — NOT AUTO-RUN. Operator reviews and executes in SQL editor.
-- Creates a normalized voter MATCH SOURCE view for petition / matcher tooling.
-- Adjust column mappings to your real warehouse (Prisma / legacy tables).
-- =============================================================================
--
-- Confirmed Prisma model `VoterRecord` (schema.prisma) on public:
--   Table: "VoterRecord"  →  physical columns include:
--   id, voterFileKey, countyFips, countyId, countySlug, city, precinct,
--   firstName, lastName, phone10, registrationDate, snapshot FKs, etc.
-- There is NO birth_date / birth_year / street / zip on VoterRecord today.
-- Map those from your voter-file ingest tables when they exist, or leave NULL.
--
-- =============================================================================

CREATE OR REPLACE VIEW public.voter_match_source AS
SELECT
  vr."id"::text AS voter_id,

  vr."firstName"::text AS first_name,
  vr."lastName"::text AS last_name,

  lower(trim(regexp_replace(coalesce(vr."firstName"::text, ''), '[[:space:]]+', ' ', 'g'))) AS first_name_norm,
  lower(trim(regexp_replace(coalesce(vr."lastName"::text, ''), '[[:space:]]+', ' ', 'g'))) AS last_name_norm,

  -- TODO: replace nulls with real DOB from your voter file / joined snapshot table
  NULL::date AS birth_date,
  NULL::integer AS birth_year,

  -- TODO: residential / mailing line from real source
  NULL::text AS address,
  NULL::text AS address_norm,

  vr."city"::text AS city,
  lower(trim(regexp_replace(coalesce(vr."city"::text, ''), '[[:space:]]+', ' ', 'g'))) AS city_norm,

  vr."countySlug"::text AS county,
  lower(trim(regexp_replace(coalesce(vr."countySlug"::text, ''), '[[:space:]]+', ' ', 'g'))) AS county_norm,

  NULL::text AS state,
  NULL::text AS zip,
  NULL::text AS zip5,

  NULL::text AS ward,
  NULL::text AS ward_norm,
  NULL::text AS precinct,
  NULL::text AS precinct_norm,
  NULL::text AS district,
  NULL::text AS district_norm,

  now()::timestamptz AS source_updated_at,
  jsonb_build_object('source', 'VoterRecord', 'note', 'template-nulls-for-dob-address-zip') AS source_metadata

FROM public."VoterRecord" vr;

-- After creating the view, set in petition_match/.env:
--   VFM_MATCH_SOURCE_TABLE=public.voter_match_source
--   VFM_CANONICAL_TABLE=public."VoterRecord"
