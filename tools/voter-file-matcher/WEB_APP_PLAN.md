# VoteMatch web app (current)

## What ships today

- **Next.js** on **Netlify** (`@netlify/plugin-nextjs`), not a static-only HTML drop.
- **Home (`/`)** — spreadsheet upload → `POST /api/ingest` → same **`runFullImport`** pipeline as the CLI (chunked staging, matching, signatures, local report dir on the server).
- **Reports (`/reports`)** — aggregate dashboard: totals (import rows, matched / not found / multiple / weak / errors, under-80, review queue, jurisdiction, duplicates, nonvoters), initiatives table, last 50 batches, confidence buckets, problem counts, ward/county rollups when views/data exist, migration warnings when optional columns/views are missing. Drilldowns: **`/reports/[batchId]`**, **`/initiatives/[petitionCode]`** (still aggregate-only; no raw signer names or addresses in HTML).
- **Health (`/api/health`)** — `ok`, `database_configured`, `upload_token_configured`, `node_env`, `app_mode`; never returns connection strings or row data.
- **Secrets** — `DATABASE_URL`, `VFM_*`, and **`VFM_UPLOAD_TOKEN`** only in server environment. Production uploads require Bearer token.

## Roadmap (not built yet)

- **Handwritten sheets (JPG/PNG)** — needs OCR + human QA before row-level normalization; do not promise legal validity from OCR alone.
- **Richer reporting widgets** — ward/county drilldowns from existing SQL views, review-queue summaries, export job triggers—extend `/reports` and/or add authenticated operator routes.
- **Stronger auth** — move beyond shared upload token to signed-in operators if the site stays public-facing.

## CLI

Local runbooks, migrations, and advanced review commands remain in **`README.md`** (this folder). The web app reuses matcher **TypeScript** on the server; it does not replace the CLI for bulk exports or migration apply.
