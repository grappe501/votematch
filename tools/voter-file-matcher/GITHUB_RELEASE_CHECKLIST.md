# GitHub / release checklist (manual)

Use this before publishing the **VoteMatch** repo or connecting Netlify. **Documentation only** (no auto-push script).

**Repository:** https://github.com/Grappe501/VoteMatch  

---

## A. Safe to publish (repo + Next app)

- **Source code** (`app/`, `components/`, `tools/voter-file-matcher/src/`, etc.)  
- **`package.json`** / **`package-lock.json`**  
- **SQL migrations** under `tools/voter-file-matcher/migrations/` (schema definitions, no live data)  
- **Sanitized docs** (no real paths, keys, or PII)  
- **`.env.example`** (placeholders only; see note in that file)  
- **`lib/reviewOperatorToken.ts`** / **`lib/operatorAuth.server.ts`** (review gate helpers; no secrets in source)  
- **`LANDING_PAGE.md`**, **`LANDING_PAGE_COPY.md`**, root **`README.md`**, and this checklist  

For **Netlify**, configure server env vars in the dashboard: **`DATABASE_URL`**, **`VFM_*`**, **`VFM_UPLOAD_TOKEN`**, and (if using OCR) **`OPENAI_API_KEY`** + **`OPENAI_OCR_MODEL`** as server-side / Functions secrets. Never commit real values for those.

---

## B. Never publish

- **`.env`** (any environment file with real secrets)  
- **`DATABASE_URL`** or other live database connection strings  
- **`SUPABASE_SERVICE_ROLE_KEY`** or other Supabase secrets  
- **`OPENAI_API_KEY`** or other third-party API secrets  
- **`VFM_UPLOAD_TOKEN`** (real upload bearer token)  
- **Real spreadsheets** (petition sheets, voter extracts)  
- **`incoming/`** real files (keep `incoming/` local; use `.gitignore`)  
- **Generated reports** under `tools/voter-file-matcher/reports/`  
- **OCR images** under `tools/voter-file-matcher/ocr-incoming/` (except the committed `README.md`)  
- **OCR output JSON** or scratch files under `tools/voter-file-matcher/ocr-output/`  
- **Handwritten scans** or petition photos with real signers  
- **Nonvoter exports**, **voter exports**, **raw signer data**  
- **Local import plan JSON** that embeds sensitive file names or hashes (sanitize or keep local)  

---

## Quick local checks (no secrets in output)

```powershell
git status
git remote -v
```

Do **not** `git add` items in section **B**. Review **`.gitignore`** before commit.

When ready to publish (manual only):

```powershell
git push -u origin main
```

---

## Before tagging or handing off

1. Confirm **`.env` is not committed** and **`.env.example` has no real secrets**.  
2. Run **`npm run typecheck`** from `petition_match/`.  
3. Run **`npm run voter-match:fixture:dry-run`**.  
4. Confirm migrations are documented for **production DBs that actually run the CLI** (separate from the static landing page).  
5. Prefer a **private** repository if the repo will ever hold operator-only material.  

---

## Before deploying OCR (image intake)

1. Apply **`migrations/008_ocr_image_intake.sql`** to the target database.  
2. Set **`OPENAI_API_KEY`** and **`OPENAI_OCR_MODEL`** in Netlify (server/Functions scope only).  
3. Set **`VFM_UPLOAD_TOKEN`** and confirm **`GET /api/health`** returns booleans only (`openai_configured`, `ocr_model_configured`, `ocr_enabled`).  
4. Confirm OCR review URLs are shared only with authorized operators (tokens in query strings are sensitive).  
