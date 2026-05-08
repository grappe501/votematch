# GitHub / release checklist (manual)

Use this before publishing the **VoteMatch** repo or connecting Netlify. **Documentation only** (no auto-push script).

**Repository:** https://github.com/Grappe501/VoteMatch  

---

## A. Safe to publish (landing page + repo)

- **Source code** (TypeScript, HTML/CSS in `public/`, etc.)  
- **Landing page** static files under **`public/`**  
- **`package.json`** / **`package-lock.json`**  
- **SQL migrations** under `tools/voter-file-matcher/migrations/` (schema definitions, no live data)  
- **Sanitized docs** (no real paths, keys, or PII)  
- **`.env.example`** (placeholders only; see note in that file)  
- **`LANDING_PAGE.md`**, **`LANDING_PAGE_COPY.md`**, root **`README.md`**, and this checklist  

For a **static Netlify landing page**, **do not** configure production secrets in Netlify unless you later add **server-side** functions that need them. The static site does not use `DATABASE_URL`, Supabase keys, or OpenAI keys.

---

## B. Never publish

- **`.env`** (any environment file with real secrets)  
- **`DATABASE_URL`** or other live database connection strings  
- **`SUPABASE_SERVICE_ROLE_KEY`** or other Supabase secrets  
- **`OPENAI_API_KEY`** or other third-party API secrets  
- **Real spreadsheets** (petition sheets, voter extracts)  
- **`incoming/`** real files (keep `incoming/` local; use `.gitignore`)  
- **Generated reports** under `tools/voter-file-matcher/reports/`  
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
