# VoteMatch web app (current)

## What ships today

- **Next.js** on **Netlify** (`@netlify/plugin-nextjs`), not a static-only HTML drop.
- **Home (`/`)** — **Spreadsheets** (`.csv` / `.xlsx` / `.xls`) → `POST /api/ingest` → same **`runFullImport`** pipeline as the CLI (chunked staging, matching, signatures, local report dir on the server). **Images** (`JPEG` / `PNG`) → `POST /api/ingest-image` → DB-backed OCR batch + OpenAI vision extraction → **human review** → import confirmed rows → **`runFullImport`**. Raw OCR never writes `voter_petition_signatures` directly.
- **OCR operator UI** — **`/ocr/[batchId]`** (batch summary) and **`/ocr/[batchId]/review`** (editable rows; may show signer-like fields). Protected with the same **`VFM_UPLOAD_TOKEN`** as uploads (`?token=` query param for browser navigation, or `Authorization: Bearer` for APIs).
- **Reports (`/reports`)** — aggregate dashboard (including **OCR batch / review / import-link counts** when migration 008 is applied). Drilldowns: **`/reports/batches`**, **`/reports/batches/[batchId]`**, **`/reports/initiatives`**, **`/reports/initiatives/[petitionCode]`** (aggregate-only; no raw signer dump on `/reports`). Legacy **`/reports/[batchId]`** and **`/initiatives/...`** redirect here.
- **Operator review (active build)** — **`/review`**, **`/review/[batchId]`**, **`/review/[batchId]/row/[rowNumber]`** plus **`/api/review/...`** routes; gated with **`VFM_UPLOAD_TOKEN`** (same as uploads) until stronger auth. Reuses matcher **`runReviewNextUnderThreshold`**, **`runSelectReviewCandidate`**, **`runMoreReviewCandidates`**, **`runPlaceNonvoter`**, **`runNeedsMoreInfo`**, **`runRejectRow`**, **`runReviewProgress`** server-side.
- **Health (`/api/health`)** — `ok`, `database_configured`, `upload_token_configured`, `openai_configured`, `ocr_model_configured`, `ocr_enabled`, `node_env`, `app_mode`; never returns secrets, connection strings, or row data.
- **Secrets** — `DATABASE_URL`, `VFM_*`, **`VFM_UPLOAD_TOKEN`**, **`OPENAI_API_KEY`**, **`OPENAI_OCR_MODEL`** only in server environment. Never in `netlify.toml` or client bundles.

## OCR admin flow (implemented)

1. Operator uploads **JPEG/PNG** with petition code (initiative must already exist in DB).
2. Server stores file under **`tools/voter-file-matcher/ocr-incoming/`**, creates **`ocr_image_batches`** / **`ocr_image_files`**, runs **OpenAI vision** (`OPENAI_OCR_MODEL`), inserts **`ocr_extracted_rows`** as draft (`NEEDS_REVIEW`).
3. Operator opens **`/ocr/{batchId}/review?token=…`**, edits cells, **Save** / **Confirm** / **Reject** rows (`PATCH /api/ocr/.../row/...`).
4. Optional **`POST /api/ocr/{batchId}/confirm`** bulk-confirms rows still in `NEEDS_REVIEW` / `EDITED`.
5. **`POST /api/ocr/{batchId}/import`** builds a Petition Mail List CSV from **CONFIRMED** or **EDITED** rows and calls **`runFullImport`** — match confidence, jurisdiction, duplicates, under-80 queue, ward/county rollups follow the normal pipeline.
6. **`ocr_to_import_batches`** links the OCR batch to **`import_batches`**.

## Future / roadmap

- **Background OCR jobs** — queue long-running vision calls; today OCR runs inline in the API request (watch **timeouts** / Netlify **maxDuration**).
- **Rate limits & cost controls** — per-org quotas, max pages per batch, model fallbacks.
- **Stronger auth** — extend beyond shared **`VFM_UPLOAD_TOKEN`** for review (sessions, SSO) if the site stays public-facing.

## CLI

Local runbooks, migrations, and advanced review commands remain in **`README.md`** (this folder). The web app reuses matcher **TypeScript** on the server; it does not replace the CLI for bulk exports or migration apply.
