# VoteMatch — public landing page (Netlify)

## Purpose

This repository includes a **public informational landing page** only. The page is **static HTML/assets** served from **`public/`** via **Netlify**.

It explains VoteMatch at a high level. It does **not** run matching, store voter data, or require any API keys.

## What the public site does not do

- **No** live voter matching on the public site.  
- **No** storage of real voter or signer data in Netlify’s static hosting.  
- **No** `DATABASE_URL`, Supabase keys, or **OpenAI API key** required for the static landing page.  
- **No** spreadsheet uploads, preflight, import execution, review UI, or report downloads on the public page.

The static landing page does **not** require an **OpenAI API key**. If AI-assisted features are added later, any OpenAI API key must be used **only from server-side code** and must **never** be exposed in browser JavaScript.

## Where the real tool lives

**Local matching, database access, SQL migrations, and reporting** live under **`tools/voter-file-matcher/`** and are documented for operators in **`tools/voter-file-matcher/README.md`**. That workflow is **private / local** (or a future secured server), not part of the public static site.

## Deployment

- **Target:** Netlify (static publish directory: **`public/`**; see **`netlify.toml`** if present).  
- **Repository:** https://github.com/Grappe501/VoteMatch  

## Copy draft

See **`LANDING_PAGE_COPY.md`** for neutral public wording you can paste into the static page.
