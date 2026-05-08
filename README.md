# RED DIRT VOTER MATCH (VoteMatch)

Standalone **petition_match** workspace: voter file matcher CLI, SQL migrations, and operator docs.

- **Runbook:** [tools/voter-file-matcher/README.md](tools/voter-file-matcher/README.md)
- **GitHub prep:** [tools/voter-file-matcher/GITHUB_RELEASE_CHECKLIST.md](tools/voter-file-matcher/GITHUB_RELEASE_CHECKLIST.md)
- **Future web UI notes:** [tools/voter-file-matcher/WEB_APP_PLAN.md](tools/voter-file-matcher/WEB_APP_PLAN.md)

## Quick start

```bash
cp .env.example .env   # fill DATABASE_URL locally; never commit .env
npm ci
npm run typecheck
npm run voter-match:fixture:dry-run
```

## Netlify

This repo deploys as a **verified build + static splash** (`public/`). Set secrets (e.g. `DATABASE_URL`) only in the Netlify UI if you later add serverless functions; the static site does not embed credentials.

Build: `npm ci && npm run typecheck` (see `netlify.toml`).
