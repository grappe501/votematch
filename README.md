# VoteMatch

**Next.js web app** (upload + reports) plus the **voter-file matcher CLI** under `tools/voter-file-matcher/`.

## Web app

- **Local folder `spreadsheets/`** is gitignored and **not** auto-imported. Use the Import page or the CLI with an explicit `--file` path (for example `./spreadsheets/your.xlsx`).
- **`npm run dev`** — local dev server (http://localhost:3000).  
- **`npm run build`** — production build (uses **webpack** so TypeScript `.js` import specifiers in the matcher resolve correctly).  
- **Upload:** `POST /api/ingest` (CSV/XLSX) and **`POST /api/ingest-image`** (JPEG/PNG OCR intake). OCR rows are **draft** until an operator reviews them; **`POST /api/ocr/{batchId}/import`** runs **`runFullImport`** on confirmed rows only—no direct permanent signatures from raw OCR.  
- **OCR operator pages:** `/ocr/[batchId]`, `/ocr/[batchId]/review` (token-gated; may show signer-like fields).  
- **Reports (aggregate):** `/reports` hub, **`/reports/batches`** (filterable list), **`/reports/batches/[batchId]`**, **`/reports/initiatives`**, **`/reports/initiatives/[petitionCode]`**. Legacy URLs **`/reports/[batchId]`** and **`/initiatives/[petitionCode]`** redirect to the new paths. No raw signer names on these pages.  
- **Operator review (protected):** **`/review`**, **`/review/[batchId]`**, **`/review/[batchId]/row/[rowNumber]`** — signer-level data. In **production**, set **`VFM_UPLOAD_TOKEN`** and pass **`?token=`**, **`Authorization: Bearer`**, or the **`votematch_operator_token`** cookie. APIs: **`/api/review/[batchId]/next`**, **`/progress`**, **`/row/[rowNumber]/candidates`**, **`select`**, **`more`**, **`nonvoter`**, **`needs-more-info`**, **`reject`**. Candidate search still needs **`VFM_CANONICAL_TABLE` / `VFM_MATCH_SOURCE_TABLE`** and **`VFM_SOURCE_PROFILE_PATH`** (or header map) on the server—never exposed to the client.  
- **Health:** `GET /api/health` — safe flags only (no `DATABASE_URL` or secrets).  
- **Auth for uploads:** set **`VFM_UPLOAD_TOKEN`** on the server; the browser sends `Authorization: Bearer …` (see `components/UploadForm.tsx`). Required in production.  
- **Overview / Netlify env:** [LANDING_PAGE.md](LANDING_PAGE.md)  
- **Product / scope notes:** [tools/voter-file-matcher/WEB_APP_PLAN.md](tools/voter-file-matcher/WEB_APP_PLAN.md)  
- **Source:** https://github.com/Grappe501/VoteMatch  

### OCR / AI image processing

- **CSV/XLSX** remains the preferred structured intake (no OpenAI required).
- **JPEG/PNG** uses **OpenAI vision on the server** (`OPENAI_API_KEY`, `OPENAI_OCR_MODEL`, optional `VFM_OCR_MAX_FILE_MB`). The browser never sees the API key.
- OCR produces **draft** `ocr_extracted_rows`; **human review is mandatory** before `POST /api/ocr/{batchId}/import`.
- **OCR confidence** (legibility of the scan) is separate from **voter match confidence** (computed later against the voter file).
- The app makes **no legal sufficiency** determination from OCR text.
- **`OPENAI_API_KEY`** belongs in **Netlify environment variables** (Functions / server scope). Do not put it in `netlify.toml` or client JavaScript.

## CLI (local / operators)

- **Runbook:** [tools/voter-file-matcher/README.md](tools/voter-file-matcher/README.md)  
- **Release checklist:** [tools/voter-file-matcher/GITHUB_RELEASE_CHECKLIST.md](tools/voter-file-matcher/GITHUB_RELEASE_CHECKLIST.md)  

## Checks

```bash
npm ci
npm run typecheck
npm run build
npm run voter-match:fixture:dry-run
```
