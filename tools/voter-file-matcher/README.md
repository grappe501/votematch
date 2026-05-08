# Voter file matcher (`tools/voter-file-matcher`)

TypeScript CLI and library code under `petition_match/` that:

1. **Parses** CSV or XLSX uploads.
2. **Maps** file headers to normalized signer fields using `configs/sos-voter-map.json` (alias lists).
3. **Stages** every row in `import_rows` (with `import_batches`, `import_files`, `import_header_maps`).
4. **Matches** each normalized row against **`VFM_CANONICAL_TABLE`** by default, or against **`VFM_MATCH_SOURCE_TABLE`** when set for **petition mail** profiles (standardized columns for stable matching). Legacy SOS map tiers stay on the canonical table unless a match source is configured (see [Voter match source layer](#voter-match-source-layer)).
5. **Records** results in `import_voter_matches`.
6. **Persists** confirmed matches as **`voter_petition_signatures`** (`UNIQUE (voter_id, petition_id)` with `ON CONFLICT DO UPDATE` so re-imports do not duplicate).
7. **Writes** a summary to `import_reports` and local files under `tools/voter-file-matcher/reports/{batch_id}/`.

## Environment loading

`src/cli.ts` calls `loadVfmEnv()` before reading `process.env`:

1. Load `petition_match/.env` when present.
2. If **`VFM_DOTENV_PATH`** is set, load that file with **override**.
3. If **`DATABASE_URL`** is still unset and `VFM_DOTENV_PATH` is unset, try **`../RedDirt/.env`** then **`./RedDirt/.env`** (same variable *names* as RedDirt; never log or print secret values).

Only **`DATABASE_URL`** is passed to `pg`. **`DIRECT_URL`** is not used.

## Voter match source layer

- **`VFM_CANONICAL_TABLE`** is the permanent voter file table (the system of record for `voter_id` values you persist).
- **`VFM_MATCH_SOURCE_TABLE`** is **optional** but **recommended** when the canonical Prisma/physical table does not directly expose DOB, birth year, residential address, or ZIP columns needed for petition-style matching.
- The match source may be a **view**, **materialized view**, or **table**; it should expose **normalized** string fields (`first_name_norm`, `last_name_norm`, `address_norm`, `city_norm`, `zip5`, etc.) so matching stays stable across formatting differences.
- **Permanent writes** to **`voter_petition_signatures`** still store the selected **`voter_id`** (and petition signature payload) exactly as before; the match source is only used to **discover** and **validate** candidates.
- The match source **does not replace** the canonical voter file. Imports and foreign-key alignment still assume the canonical table exists where the pipeline expects it; operators install a view (see `migrations/003_match_source_template.sql`) that maps canonical rows into the standard column contract (`configs/match-source-standard.json`).
- For **Petition Mail List Share** spreadsheets (`configs/petition-mail-list-share-v1.json`), match quality depends on **birth date or year**, **address**, **city**, **state**, and **ZIP** being available from the match source (or, without a match source, on those columns existing on **`VFM_CANONICAL_TABLE`**—often they do not on raw `VoterRecord`).

Example env (paths relative to `petition_match/`):

```env
VFM_DOTENV_PATH=../RedDirt/.env
VFM_PROJECT_KEY=sos
VFM_CANONICAL_TABLE=public."VoterRecord"
VFM_MATCH_SOURCE_TABLE=public.voter_match_source
VFM_SOURCE_PROFILE_PATH=tools/voter-file-matcher/configs/petition-mail-list-share-v1.json
VFM_CHUNK_SIZE=500
```

Diagnostics (no DB writes except read-only metadata/column checks):

```powershell
npm run voter-match -- --inspect-voter-source
npm run voter-match -- --validate-config --validate-db --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json
npm run voter-match -- --match-readiness --file "H:\SOSWebsite\petition_match\incoming\Petition Mail List Share 1 (1).xlsx" --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json
npm run voter-match -- --candidate-probe --file "H:\SOSWebsite\petition_match\incoming\Petition Mail List Share 1 (1).xlsx" --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json --limit 25
```

## Creating the voter match source view

This workflow uses **information_schema only** for discovery and planning (no voter row reads). The plan JSON and emitted SQL are **drafts**; review before any apply. **`--apply-match-source-sql`** is the only command that writes DDL, and it requires **`--confirm-apply-match-source`**. Permanent **`voter_petition_signatures`** rows are unchanged by this tooling except through normal imports after you point **`VFM_MATCH_SOURCE_TABLE`** at the view.

**Step 1:**

```powershell
npm run voter-match -- --discover-voter-schema
```

**Step 2:**

```powershell
npm run voter-match -- --plan-match-source
```

**Step 3:**

Open:

`tools/voter-file-matcher/reports/match-source-plan.json`

Review and edit mappings if needed.

**Step 4:**

```powershell
npm run voter-match -- --emit-match-source-sql
```

**Step 5:**

Open:

`tools/voter-file-matcher/reports/create-voter-match-source.sql`

Review SQL carefully.

**Step 6:**

```powershell
npm run voter-match -- --apply-match-source-sql --sql tools/voter-file-matcher/reports/create-voter-match-source.sql --confirm-apply-match-source
```

**Step 7:**

Set:

`VFM_MATCH_SOURCE_TABLE=public.voter_match_source`

**Step 8:**

```powershell
npm run voter-match -- --inspect-voter-source
```

**Step 9:**

```powershell
npm run voter-match -- --match-readiness --file "./tools/voter-file-matcher/incoming/Petition Mail List Share 1 (1).xlsx" --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json
```

Notes:

- Discovery reads **schema metadata only**, never voter rows.
- The plan is a **draft**; joins to related tables are never auto-generated.
- SQL must be **human-reviewed** before apply; the tool only allows a single **`CREATE OR REPLACE VIEW`** for the configured target and rejects destructive keywords.
- Applying creates or replaces **only** the match-source view definition.
- **Do not commit** real spreadsheets, generated voter exports, or production-only plan/SQL artifacts if your policy forbids it (`tools/voter-file-matcher/reports/` is gitignored by default).

Optional flags:

- **`--discover-voter-schema --json`**: machine-readable discovery.
- **`--discover-voter-schema --include-related`**: include other `public` tables whose names or columns look voter/address-related (join keys are name-based hints only).
- **`--plan-match-source --include-related`**: fold related-table **warnings** into the plan (still maps from the canonical table only unless you edit the plan).
- **`--canonical-table public."VoterRecord"`**: override **`VFM_CANONICAL_TABLE`** for discovery/plan.
- **`--target public.voter_match_source`**: view name for plan metadata, emit, and apply safety checks.

## Step 0: Create or select the ballot initiative

All imported signatures roll up under a **`petition_code`** (the initiative code). The database table is still **`petitions`**; CLI and docs use **initiative** and **petition** as the same concept.

Before your first real import for a code, register metadata (scope, reporting geography, optional target count):

**City election / ward reporting:**

```powershell
npm run voter-match -- --upsert-initiative --petition-code JACKSONVILLE_2026 --petition-name "Jacksonville Ballot Initiative" --initiative-scope CITY --reporting-geo WARD --target-signature-count 1000 --project sos
```

**Statewide initiative / county reporting:**

```powershell
npm run voter-match -- --upsert-initiative --petition-code AR_STATEWIDE_2026 --petition-name "Arkansas Statewide Initiative" --initiative-scope STATEWIDE --reporting-geo COUNTY --target-signature-count 90000 --project sos
```

Then run **`--prepare-import-plan`** / **`--execute-import-plan`** or a direct import using the same **`--petition-code`**.

**List initiatives:**

```powershell
npm run voter-match -- --list-initiatives --project sos
```

**Rollup summary for one initiative:**

```powershell
npm run voter-match -- --initiative-summary JACKSONVILLE_2026 --json
```

If an initiative row does not exist yet, **`--prepare-import-plan`** warns unless you pass **`--auto-create-initiative`** together with **`--petition-name`** and **`--reporting-geo`**. Executing a plan (or **`runFullImport`**) requires a **`reporting_geo`** value on the initiative or on the create flags.

Apply **`migrations/006_confidence_initiative_rollups.sql`** after **`005`** so **`match_confidence_pct`** columns, initiative metadata on **`petitions`**, and rollup views (`initiative_signature_rollup`, `initiative_ward_counts`, `initiative_county_counts`, `initiative_review_confidence_queue`) exist.

## Confidence percentages

- **`100%`**: slam-dunk identity match (exact voter id / strongest tiered match with clean QA, as scored in `src/confidence.ts`).
- **`0%`**: no usable voter candidate or not enough searchable information.
- **About `50%` or below**: usually needs manual search or review even when a candidate exists.
- The percentage is **identity-match confidence**, not legal validity of the signature on the ballot.
- Rows can still need review for **notes**, **future signed date**, or **possible duplicate within file** even when identity confidence is high.

## City vs statewide reporting

- **`initiative_scope` `CITY`** with **`reporting_geo` `WARD`**: use **`matched_by_ward.csv`** / ward columns in operator reports; missing ward on the match source yields **`UNKNOWN`** and a warning.
- **`STATEWIDE`** (or county-centric **`reporting_geo` `COUNTY`**)**: use **`matched_by_county.csv`**; missing **`signer_county`** on imports yields **`UNKNOWN`** and a warning.

## Local reporting and review workflow

Apply **`migrations/005_reporting_review_views.sql`**, then **`migrations/006_confidence_initiative_rollups.sql`**, so views `batch_signature_report_rows`, `batch_review_queue_enriched`, and `petition_ward_signature_counts` exist (005), and confidence plus initiative rollups (006) are available. **`voter_petition_signatures`** has optional **`voter_ward`**, **`voter_precinct`**, **`voter_district`** (populated on auto-match and manual approve when the match source exposes those columns).

### Report one import batch

```powershell
npm run voter-match -- --report-batch <batch_uuid> --out tools/voter-file-matcher/reports/<batch_uuid>
```

Optional: `--json` (includes full `summary.json` payload on stdout), `--include-sensitive` (prints extra signer fields to the console for `--next-review-row` only; default console output stays minimal).

**Artifacts** (under `--out`, default `tools/voter-file-matcher/reports/<batch_id>/`):

| File | Purpose |
|------|---------|
| `summary.json` | Totals, rates, ward_counts, problem_counts, top_problems, QA/city/zip aggregates, warnings, initiative_scope/reporting_geo (006), confidence buckets |
| `matched_slam_dunk.csv` | Auto-matched high-confidence rows (includes `match_confidence_pct` when 006 applied) |
| `matched_needs_review.csv` | `MATCHED` but not slam-dunk |
| `do_not_match_review.csv` / `review_queue.csv` | Every row that still needs staff attention (not slam-dunk or non-match statuses) |
| `matched_by_ward.csv` | Signature counts by stored ward (UNKNOWN when ward not captured) |
| `biggest_problems.csv` | Problem taxonomy with counts, example row numbers, recommended actions |
| `qa_flags.csv` | QA flags with **match_status** and **review_status** |
| `report_workbook.xlsx` | Multi-sheet workbook (Summary, slam-dunk, review, ward, problems, QA) |

**Totals**: `summary.json` → `total_rows`, `total_signatures`, `matched_total`, `slam_dunk_matched`, `needs_review_total`, and status buckets.

**Matched per ward**: `matched_by_ward.csv` or `summary.json` → `ward_counts` (requires ward/district on the match source to populate `voter_ward`; otherwise expect UNKNOWN and a warning).

### Report all batches for a petition code

```powershell
npm run voter-match -- --report-petition JACKSONVILLE_2026 --out tools/voter-file-matcher/reports/petition-JACKSONVILLE_2026
```

Produces `petition_summary.json`, `petition_matched_by_ward.csv`, `petition_all_signatures.csv`, `petition_review_remaining.csv`, `petition_biggest_problems.csv`, and `petition_report_workbook.xlsx`.

### One-by-one review loop (CLI)

```powershell
npm run voter-match -- --report-batch <batch_id>
npm run voter-match -- --next-review-row --batch-id <batch_id>
npm run voter-match -- --search-voters-for-row --batch-id <batch_id> --row-number 17 --map ./tools/voter-file-matcher/configs/sos-voter-map.json
npm run voter-match -- --approve-review-candidate --batch-id <batch_id> --row-number 17 --voter-id <id> --reviewed-by "Admin" --note "Matched by search"
npm run voter-match -- --review-progress --batch-id <batch_id>
npm run voter-match -- --skip-review-row --batch-id <batch_id> --row-number 17 --reviewed-by "Admin" --note "Need more info"
npm run voter-match -- --reject-review-row --batch-id <batch_id> --row-number 17 --reviewed-by "Admin" --note "Not registered"
```

- **`--approve-review-candidate`** wraps **`--approve-row`**: validates the voter in the match source or canonical table, upserts **`voter_petition_signatures`** (with geo when available), and writes audit rows.
- **`--skip-review-row`** is an alias for **`--needs-more-info`**; **`--reject-review-row`** aliases **`--reject-row`**.
- **`--search-voters-for-row`** is read-only; override parts of the signer with `--search-last-name`, `--search-first-name`, `--search-city`, `--search-zip`, `--search-address`; use **`--omit-address-search`** to skip address-based strategies.

A future Netlify UI is outlined in `WEB_APP_PLAN.md`. **Verify local reports before** any hosted app work.

## Guarded production import plans

Recommended path before a **non–dry-run** import using **`petition-mail-list-share-v1`**: capture preflight, DB readiness, candidate-probe aggregates, and hashes in a JSON plan; have an operator mark it **REVIEWED**; then execute with an explicit confirmation. Direct imports with that profile **fail** unless you pass **`--confirm-direct-import`** (development / emergency only).

Apply **`migrations/004_import_plan_guardrails.sql`** to enable optional **`import_plans`** persistence (`--save-plan-db`). `--validate-db` reports when migration 004 is missing.

1. Place the real file under `tools/voter-file-matcher/incoming/` (never commit it).

2. Prepare plan:

```powershell
npm run voter-match -- --prepare-import-plan --file "./tools/voter-file-matcher/incoming/Petition Mail List Share 1 (1).xlsx" --project sos --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json --petition-code JACKSONVILLE_2026 --petition-name "Jacksonville Petition" --source-label "Petition Mail List Share 1" --save-plan-db
```

3. Inspect the generated JSON under `tools/voter-file-matcher/reports/import-plans/`.

4. Review plan:

```powershell
npm run voter-match -- --review-import-plan --plan tools/voter-file-matcher/reports/import-plans/<plan_key>.json --reviewed-by "Admin" --note "Reviewed preflight/readiness/probe" --save-plan-db
```

5. Execute plan:

```powershell
npm run voter-match -- --execute-import-plan --plan tools/voter-file-matcher/reports/import-plans/<plan_key>.json --confirm-execute-import --created-by "Admin" --save-plan-db
```

6. Check batch:

```powershell
npm run voter-match -- --batch-summary <batch_id>
```

7. Export review queue:

```powershell
npm run voter-match -- --export-review-queue --batch-id <batch_id>
```

**Warnings**

- Plan execution permanently writes **`voter_petition_signatures`** for rows that **`MATCH`**.
- Weak / multiple / not-found rows still require **human review** in the queue.
- If the source file changes after review, execution **fails** on SHA-256 mismatch unless **`--allow-file-hash-mismatch`** is set intentionally.
- **`--confirm-direct-import`** bypasses the plan guardrail; use sparingly.

## First-time database validation and import (runbook)

Follow this order before the first **real** petition upload. The fixture is synthetic; `MATCHED` rows only appear if the canonical table actually contains rows that align with the fake IDs or name/location fields—otherwise **`NOT_FOUND` still proves** staging, matching, reporting, and (when applicable) signature upserts.

### 1. Matcher env (`petition_match/.env`)

Set at least:

```env
VFM_DOTENV_PATH=../RedDirt/.env
VFM_PROJECT_KEY=sos
VFM_CANONICAL_TABLE=public.YOUR_REAL_VOTER_TABLE
# Optional: see "Voter match source layer" above.
# VFM_MATCH_SOURCE_TABLE=public.voter_match_source
VFM_HEADER_MAP_PATH=tools/voter-file-matcher/configs/sos-voter-map.json
# Optional default for petition mail imports (instead of --profile each time):
# VFM_SOURCE_PROFILE_PATH=tools/voter-file-matcher/configs/petition-mail-list-share-v1.json
VFM_CHUNK_SIZE=500
```

Use the **exact** Postgres table name for your voter roll. If Prisma (or other tooling) created **quoted mixed-case** identifiers, match what Postgres stores (`information_schema` / `\dt` in `psql`). Then align **`configs/sos-voter-map.json`** `canonicalDatabase.columns` to those **physical** column names.

### 2. Apply the migration

From `H:\SOSWebsite\petition_match`, with **`DATABASE_URL`** available in the shell (e.g. terminal loaded `.env`, or paste into Supabase SQL editor):

**PowerShell:**

```powershell
psql $env:DATABASE_URL -f tools/voter-file-matcher/migrations/001_import_matcher_tables.sql
```

**Bash:**

```bash
psql "$DATABASE_URL" -f tools/voter-file-matcher/migrations/001_import_matcher_tables.sql
```

Or open the migration file in the **Supabase SQL editor** and run it once.

Then apply **migration 002** (human review queue, audit tables, signature event log, and views). Safe after 001:

**PowerShell:**

```powershell
psql $env:DATABASE_URL -f tools/voter-file-matcher/migrations/002_review_resolution_audit.sql
```

**Bash:**

```bash
psql "$DATABASE_URL" -f tools/voter-file-matcher/migrations/002_review_resolution_audit.sql
```

Then optionally apply **migration 004** (`import_plans` for guarded production plans and `--save-plan-db`):

```powershell
psql $env:DATABASE_URL -f tools/voter-file-matcher/migrations/004_import_plan_guardrails.sql
```

Then optionally apply **migration 005** (ward/precinct/district columns on signatures, reporting views, `batch_review_queue_enriched`):

```powershell
psql $env:DATABASE_URL -f tools/voter-file-matcher/migrations/005_reporting_review_views.sql
```

### 3. Validate config

```powershell
npm run voter-match -- --validate-config --map ./tools/voter-file-matcher/configs/sos-voter-map.json
```

### 4. Validate DB

Checks migration **001** tables, migration **002** review/audit objects and views, **`VFM_CANONICAL_TABLE`**, map columns on the canonical table, migration **004** `import_plans` when relevant (`plan_migration_notes` when it does not), and migration **005** reporting views / `voter_ward` column (non-fatal notes when optional objects are missing). When **`VFM_MATCH_SOURCE_TABLE`** is set, warns if no ward/precinct/district-like columns are present (ward rollups fall back to UNKNOWN).

```powershell
npm run voter-match -- --validate-config --validate-db --map ./tools/voter-file-matcher/configs/sos-voter-map.json
```

If 001 is present but 002 is not, the tool reports that **`002_review_resolution_audit.sql`** should be applied.

### 5. Fixture dry-run (no DB writes)

```powershell
npm run voter-match:fixture:dry-run
```

### 6. Fixture real import

Only after steps 2–4 succeed:

```powershell
npm run voter-match -- --file ./tools/voter-file-matcher/fixtures/sample-signers.csv --project sos --map ./tools/voter-file-matcher/configs/sos-voter-map.json --petition-code FIXTURE_TEST --petition-name "Fixture Test Petition" --source-label fixture
```

### 7. Check permanent signature behavior

```sql
select *
from voter_petition_signatures
where petition_code = 'FIXTURE_TEST';

select voter_id, count(*)
from voter_petition_signatures
where petition_code = 'FIXTURE_TEST'
group by voter_id
having count(*) > 1;
```

The second query should return **zero** rows (`UNIQUE (voter_id, petition_id)` + `ON CONFLICT DO UPDATE`).

At this point, the remaining risk before **production** petition files is **map ↔ canonical column alignment**. Once `canonicalDatabase.columns` matches the live table exactly, you are ready for a controlled real import.

## Review and manual resolution workflow

Use this after an import when you need staff to resolve **`MULTIPLE_MATCHES`**, **`WEAK_MATCH`**, **`NOT_FOUND`**, or **`ERROR`** rows without editing SQL by hand. **`--approve-row`** permanently attaches a signer to **`voter_petition_signatures`** (same unique key as automatic imports). **Always verify** the canonical **`--voter-id`** before approving.

**Warnings**

- Manual approval **writes or updates** a permanent signature row and records **`MANUAL_ATTACH_FROM_REVIEW`** in **`voter_petition_signature_events`**.
- Wrong **`--voter-id`** can attach the petition to the wrong voter in the database.
- **`--reject-row`** and **`--needs-more-info`** do not delete or alter existing permanent signatures.
- This release does **not** implement destructive detachment from permanent signatures; audit-only paths are reserved for future work.

### Batch summary

```powershell
npm run voter-match -- --batch-summary <batch_id>
```

Add **`--json`** for machine-readable output.

### Review queue (console)

Default filter: **`MULTIPLE_MATCHES,WEAK_MATCH,NOT_FOUND,ERROR`** with **`review_status`** in **`UNREVIEWED`** or **`NEEDS_MORE_INFO`**.

```powershell
npm run voter-match -- --review-queue --batch-id <batch_id>
npm run voter-match -- --review-queue --batch-id <batch_id> --status MULTIPLE_MATCHES,NOT_FOUND --limit 100 --json
```

### Export review queue CSV

Default path: **`tools/voter-file-matcher/reports/{batch_id}/review_queue.csv`**

```powershell
npm run voter-match -- --export-review-queue --batch-id <batch_id>
npm run voter-match -- --export-review-queue --batch-id <batch_id> --out H:\exports\queue.csv
```

### Approve a row (manual attach)

Requires **`VFM_CANONICAL_TABLE`**, **`--map`** (or profile env), and a batch whose **`import_batches.petition_id`** is set (normal imports satisfy this).

```powershell
npm run voter-match -- --approve-row --batch-id <batch_id> --row-number 12 --voter-id FAKE-VRN-JAX-001 --reviewed-by "Admin" --note "Matched by voter ID from reviewed source file" --map ./tools/voter-file-matcher/configs/sos-voter-map.json
```

### Reject a row

```powershell
npm run voter-match -- --reject-row --batch-id <batch_id> --row-number 13 --reviewed-by "Admin" --note "No matching voter found after review"
```

### Mark needs more info

```powershell
npm run voter-match -- --needs-more-info --batch-id <batch_id> --row-number 14 --reviewed-by "Admin" --note "Address incomplete"
```

### Add a note only

Appends **`ADD_NOTE`** to **`import_match_reviews`**. If a permanent signature already exists for the row’s voter and petition, a **`MANUAL_REVIEW_NOTE`** event is also written.

```powershell
npm run voter-match -- --add-review-note --batch-id <batch_id> --row-number 15 --reviewed-by "Admin" --note "Check county spelling"
```

### Example: Jacksonville signers (parameterized)

```sql
select *
from voter_petition_signatures
where lower(btrim(COALESCE(signer_city, ''))) = 'jacksonville'
  and petition_code = $1;
```

### Example: audit trail for a petition

```sql
select *
from petition_signature_audit
where petition_code = $1
order by updated_at desc
limit 100;

select *
from voter_petition_signature_events
where petition_code = $1
order by created_at desc
limit 100;

select *
from import_match_reviews
where import_batch_id = $1::uuid
order by created_at desc;
```

## Quick reference (bash / other shells)

The [runbook](#first-time-database-validation-and-import-runbook) uses PowerShell for `psql` and `npm`. On bash, use `psql "$DATABASE_URL" -f ...` and the same `npm run voter-match -- ...` lines. Fixture CSV details: `fixtures/README.md`. Optional Windows-safe dry-run alias: `npm run voter-match:fixture:dry-run` (uses `--petition-name FixtureTestPetition`).

## Config / DB validation (no secrets printed)

See runbook **§3–§4** for the recommended commands. Summary:

- **`--validate-config`** — checks `DATABASE_URL` is configured (boolean only), `VFM_CANONICAL_TABLE` is set, map file parses, required `headerAliases.*` lists exist, and canonical column map builds. **Does not connect** to Postgres unless **`--validate-db`** is also passed.
- **`--validate-db`** — requires successful config validation first; then connects, checks migration **001** tables, migration **002** review/audit tables and views, verifies **`VFM_CANONICAL_TABLE`** exists, and checks that **every physical column** listed in the map’s `canonicalDatabase.columns` exists on that table (`information_schema.columns`, case-insensitive fallback). For **`matching.tierSet: "petition_mail"`**, informational warnings are emitted when optional columns (for example `birth_date`, `birth_year`, `address`, `zip`) are not mapped so higher match tiers are skipped.

Example:

```bash
npm run voter-match -- --validate-config --validate-db --map ./tools/voter-file-matcher/configs/sos-voter-map.json
```

## Reports directory

After a successful (non–dry-run) import, artifacts are written to:

`tools/voter-file-matcher/reports/{batch_id}/`

(`summary.json`, status-specific CSVs, and **`qa_flags.csv`** when an import completes.) That tree is gitignored.

## `--map` vs `--profile`

- **`--map`** — path to a header map JSON (same as today). **`VFM_HEADER_MAP_PATH`** is used when `--map` / `--profile` are omitted.
- **`--profile`** — path to a **source profile** JSON: same required shape as a map (`canonicalDatabase`, `headerAliases`) plus optional `sheetName`, `headerRow`, `dataStartRow`, `columnPositions`, `normalization`, `qa`, `matching`, and `validation`. **`VFM_SOURCE_PROFILE_PATH`** is used when neither flag is passed (profile wins over `VFM_HEADER_MAP_PATH` if both env vars are set—resolve explicitly with flags to avoid surprises).
- **Do not pass both** `--map` and `--profile`; the CLI exits with: `Pass either --map or --profile, not both.`

## `--preflight-file` (no database)

Parses the workbook, applies the profile (aliases + positional columns), normalizes rows, runs QA and within-file duplicate detection, and prints a **safe JSON summary** (counts, aggregates, header names, mapped field list). It does **not** connect to Postgres, does **not** insert batches or rows, and does **not** print signer names, street addresses, or raw row payloads.

## Importing Petition Mail List Share spreadsheets

Use this path when the upload matches the **“Petition Mail List Share”** layout (single sheet `Sheet1`, row 1 headers, data from row 2, columns through `NOTES`).

- **Do not commit** real spreadsheets. Keep them under `incoming/` or `tools/voter-file-matcher/incoming/` (gitignored except `incoming/README.md`).
- Use the profile file: **`tools/voter-file-matcher/configs/petition-mail-list-share-v1.json`** (pass as **`--profile`**, or set **`VFM_SOURCE_PROFILE_PATH`** to that path).
- Run **`--preflight-file`** first. Preflight does not connect to the DB and does not write matcher tables.
- **Column F → `address` by position:** the sheet’s column F holds street address values while the header cell is often **not** a normal label. Positional mapping fills `address` when there is no usable **`headerAliases.address`** match; if a separate **Address** column exists (for example on a CSV), the alias value wins and column F is ignored.
- **`DATE SIGNED`** may be an **Excel serial** number; the profile converts it to an ISO calendar date and stores the raw cell in `normalized_json.signed_at_raw`.
- **`BIRTH MONTH` / `BIRTH DAY` / `BIRTH YEAR`** are combined into **`birth_date`** when all parts are valid; two-digit or pre-1900 years do not guess silently (see **`INVALID_BIRTH_YEAR`** / **`INVALID_BIRTH_DATE`** QA flags).
- **`_qa_flags`** on each row are **informational**; they do not auto-reject rows. **`WEAK_MATCH`**, **`MULTIPLE_MATCHES`**, and **`NOT_FOUND`** rows should follow your operator review / export workflow (`review` tooling, SQL queues, etc.).

### Example preflight

```powershell
npm run voter-match -- --preflight-file --file "H:\SOSWebsite\petition_match\incoming\Petition Mail List Share 1 (1).xlsx" --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json
```

### Example dry run

```powershell
npm run voter-match -- --file "H:\SOSWebsite\petition_match\incoming\Petition Mail List Share 1 (1).xlsx" --project sos --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json --petition-code JACKSONVILLE_2026 --petition-name "Jacksonville Petition" --source-label "Petition Mail List Share 1" --dry-run
```

### Example real import

```powershell
npm run voter-match -- --file "H:\SOSWebsite\petition_match\incoming\Petition Mail List Share 1 (1).xlsx" --project sos --profile ./tools/voter-file-matcher/configs/petition-mail-list-share-v1.json --petition-code JACKSONVILLE_2026 --petition-name "Jacksonville Petition" --source-label "Petition Mail List Share 1"
```

### Example post-import review

After a run, the CLI prints `batch_id` and `report_dir`. Inspect `summary.json`, status CSVs, and **`qa_flags.csv`** under `tools/voter-file-matcher/reports/{batch_id}/`. For database-side review queues, audits, and CSV exports, use the helpers in **`src/review.ts`** (import from your own `tsx` script or app layer) and the SQL views created by migrations—there is no separate `npm run voter-match -- --batch-summary` subcommand on the matcher CLI today.

## Querying Jacksonville signers

Application SQL (parameterize `petition_code` in apps):

```sql
select *
from voter_petition_signatures
where lower(signer_city) = 'jacksonville'
  and petition_code = $1;
```

View `jacksonville_petition_signers` (all petitions) is also created by the migration.

## Security / hygiene

- **Never commit** production petition files, voter file exports, or `.env` contents.
- Use **`fixtures/sample-signers.csv`** and **`FIXTURE_TEST`** for smoke tests only.
