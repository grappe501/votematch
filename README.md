# VoteMatch

**Next.js web app** (upload + reports) plus the **voter-file matcher CLI** under `tools/voter-file-matcher/`.

## Web app

- **Local folder `spreadsheets/`** is gitignored and **not** auto-imported. Use the Import page or the CLI with an explicit `--file` path (for example `./spreadsheets/your.xlsx`).
- **`npm run dev`** — local dev server (http://localhost:3000).  
- **`npm run build`** — production build (uses **webpack** so TypeScript `.js` import specifiers in the matcher resolve correctly).  
- **Upload:** `POST /api/ingest` (spreadsheet path; no OCR in the public flow). **Reports:** `/reports` plus drilldowns `/reports/[batchId]` and `/initiatives/[petitionCode]`—all **aggregate** DB metrics; no raw signer rows in HTML.  
- **Health:** `GET /api/health` — safe flags only (no `DATABASE_URL` or secrets).  
- **Auth for uploads:** set **`VFM_UPLOAD_TOKEN`** on the server; the browser sends `Authorization: Bearer …` (see `components/UploadForm.tsx`). Required in production.  
- **Overview / Netlify env:** [LANDING_PAGE.md](LANDING_PAGE.md)  
- **Product / scope notes:** [tools/voter-file-matcher/WEB_APP_PLAN.md](tools/voter-file-matcher/WEB_APP_PLAN.md)  
- **Source:** https://github.com/Grappe501/VoteMatch  

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
