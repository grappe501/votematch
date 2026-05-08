# GitHub / release checklist (manual)

Use this as an operator checklist before publishing the matcher repo or connecting Netlify. **This is documentation only** (no auto-push script).

**Target remote (VoteMatch / RED DIRT VOTER MATCH):** `https://github.com/Grappe501/VoteMatch`

Safe local checks (no secrets in output):

```powershell
git status
git remote -v
git remote add origin https://github.com/Grappe501/VoteMatch.git
git branch -M main
git add tools/voter-file-matcher package.json package-lock.json README.md
git status
```

Do **not** `git add` or commit: **`.env`**, **`incoming/`** real files, **`reports/`**, real spreadsheets, Supabase URLs, or generated XLSX reports. Review `.gitignore` before commit.

When ready to publish (manual only; no scripted push here):

```powershell
git push -u origin main
```

1. Remove any **real incoming** spreadsheets from the working tree (use `incoming/` only locally; it is gitignored except `README`).
2. Remove **generated reports** under `tools/voter-file-matcher/reports/` (gitignored, but verify nothing was force-added).
3. Confirm **`.env` is not committed** and that **`.env.example` contains no secrets** (placeholders only).
4. Run **`npm run typecheck`** from `petition_match/`.
5. Run **`npm run voter-match:fixture:dry-run`**.
6. Confirm **SQL migrations** through `006_confidence_initiative_rollups.sql` are documented and applied on production DBs that need confidence columns, initiative metadata, and rollup views (after `005` for base reporting views).
7. Update **`README.md`** runbook if commands or env vars changed.
8. Prefer a **private GitHub repository** first when voter workflows are involved.
9. Configure **Netlify (or host) environment variables** only in the provider dashboard; do not embed Supabase or Postgres credentials in client code.
10. Do **not** commit Supabase service keys, `DATABASE_URL`, or production voter extracts.
