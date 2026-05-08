# Public Netlify site: static landing page (plan)

This repository’s **deployed Netlify output** is a **simple static landing page** only (`public/`). It does **not** run the voter matcher, host uploads, show review queues, or connect to a database.

## What the landing page includes

- **VoteMatch** name and a short neutral description.
- **High-level** explanation of what the matching tool does in principle:
  - spreadsheet-to-voter-file matching (conceptually),
  - confidence scoring,
  - review queue workflow (conceptually),
  - ward/county-style reporting (conceptually),
  - **local / private** handling of sensitive data (matching is not performed on the public page).
- Clear note that **actual matching, imports, and reports run locally** (or in any future private environment you control)—**not** on this public page.
- **Contact** or request-access block, if present in the static HTML.
- Link to the open repository: **https://github.com/Grappe501/VoteMatch**

## Explicitly out of scope for the public landing page

The static site does **not** include and does **not** require:

- Upload spreadsheet UI  
- Preflight or import-plan UI  
- Execute-import UI  
- Review queue UI  
- Voter search UI  
- Admin dashboard UI  
- `DATABASE_URL`, Supabase keys, or OpenAI keys in the browser or in static assets  
- Instructions to embed production database credentials in Netlify for this landing page  
- Exposure of generated reports, nonvoter exports, or raw signer data  

## Future (private) application

An **authenticated private admin application** may be built later for operators. If so, **database access must remain server-side only** (no secrets in client bundles, no public report URLs without auth).

Technical runbooks, CLI commands, migrations, and operator workflows stay in **`tools/voter-file-matcher/README.md`** and related **local** docs—not on the public landing page.
