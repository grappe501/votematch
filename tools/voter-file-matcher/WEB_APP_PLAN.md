# Future Netlify web app (plan only)

This document describes a **later** hosted UI on Netlify (e.g. **RED DIRT VOTER MATCH** / VoteMatch). **No public web upload is implemented in this repository slice**; operators use the local CLI and gitignored reports first.

## Top-of-flow form (initiative first)

Before upload or import, the operator selects or creates the **ballot initiative** (same as `petitions` row):

1. **Initiative code** (`petition_code`, unique).
2. **Initiative display name** (`petition_name`).
3. **Scope**: City / County / Statewide / District / Other (`initiative_scope`).
4. **Reporting geo**: Ward / County / Precinct / District / City / None (`reporting_geo`) — required for meaningful rollups.
5. **Target signature count** (optional progress bar).
6. **Upload** spreadsheet (CSV/XLSX) — server-side parse only.
7. **Preflight** → **Prepare plan** → **Execute plan** (with explicit confirm).
8. **Reports dashboard** (summary, ward/county CSVs, workbook, confidence distribution).
9. **Review queue** (authenticated staff; same semantics as CLI review).

## Goals

1. **Authentication** required before any deployment that touches real voter data (e.g. Supabase Auth, SSO, or internal VPN-only deployment).
2. **Upload** a spreadsheet (CSV/XLSX) through a **server-side** handler only; never send `DATABASE_URL` or other secrets to the browser.
3. **Preflight** the file (parse, map, QA) and show a safe summary (counts, warnings, no bulk PII in logs).
4. **Prepare import plan** (guarded plan JSON + optional DB row) and let a human mark it reviewed.
5. **Execute import plan** (or controlled direct import) with explicit confirmation.
6. **Show reports** generated server-side: totals, slam-dunk vs needs-review, ward rollups, biggest problems, full CSV download links for operators (not public unless explicitly exported).
7. **Review unmatched rows one by one**: queue from `batch_review_queue_enriched`, show signer fields only to authenticated staff.
8. **Search voter source** using the same strategies as `--search-voters-for-row` (parameterized SQL server-side).
9. **Approve / reject / needs-more-info** via server actions that call the same persistence rules as the CLI (`voter_petition_signatures`, `import_match_reviews`, `voter_petition_signature_events`).

## Architecture notes

- **Server-side DB access only** (Netlify Functions, Edge with Postgres pool, or a small API backend).
- **Never expose `DATABASE_URL`** to the browser or client bundles.
- **Generated reports** stay private (signed URLs, operator session, or download after auth); do not place under public static assets by default.
