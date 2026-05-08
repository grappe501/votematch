# VoteMatch

Public **static landing page** (Netlify) plus a **local** voter-file matcher under `tools/voter-file-matcher/`.

## Public site (Netlify)

The deployed site is **informational only**: no matching, no uploads, no voter data, no secrets in the browser.

- **Landing page overview:** [LANDING_PAGE.md](LANDING_PAGE.md)  
- **Suggested public copy:** [LANDING_PAGE_COPY.md](LANDING_PAGE_COPY.md)  
- **High-level product notes (static scope):** [tools/voter-file-matcher/WEB_APP_PLAN.md](tools/voter-file-matcher/WEB_APP_PLAN.md)  
- **Source:** https://github.com/Grappe501/VoteMatch  

## Local matcher (developers / operators)

The CLI, SQL migrations, and technical runbooks live in **`tools/voter-file-matcher/`**:

- **Runbook:** [tools/voter-file-matcher/README.md](tools/voter-file-matcher/README.md)  
- **Release checklist:** [tools/voter-file-matcher/GITHUB_RELEASE_CHECKLIST.md](tools/voter-file-matcher/GITHUB_RELEASE_CHECKLIST.md)  

Use **`.env.example`** only when running the matcher **locally**; it is not used by the static landing page.

## Repository checks (local)

```bash
npm ci
npm run typecheck
npm run voter-match:fixture:dry-run
```
