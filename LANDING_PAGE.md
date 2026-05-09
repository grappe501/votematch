# Signature Match — public web app (Netlify)

## Purpose

This repository ships a **Next.js** application (not a static-only site): **upload**, **server-side import** into Postgres using the existing matcher pipeline, and a **Reports** page with aggregate metrics.

**JPEG/PNG** petition photos use **server-side OCR** (`POST /api/ingest-image`, OpenAI vision) with **mandatory human review** before rows enter the normal import/match pipeline. Spreadsheets **CSV / XLSX / XLS** use the Petition Mail List Share profile by default (`VFM_SOURCE_PROFILE_PATH`) and do not require OpenAI.

## Security

- **`DATABASE_URL`** and **`VFM_DOTENV_PATH`** exist only on the **server** (Netlify environment or local `.env`). They are never exposed to the browser bundle.
- **`VFM_UPLOAD_TOKEN`**: In **production**, uploads require `Authorization: Bearer <token>`. Set a long random value in Netlify. Without it, `POST /api/ingest` returns 503.
- Do not commit real spreadsheets, reports, or `.env` files.

## Local development

```bash
npm ci
cp .env.example .env   # then edit; point VFM_DOTENV_PATH at RedDirt/.env as needed
npm run dev
```

Open **http://localhost:3000** (upload), **http://localhost:3000/reports** (aggregate dashboard), **http://localhost:3000/api/health** (safe status JSON). Initiative and batch drilldowns live at `/initiatives/[code]` and `/reports/[batchId]`—still aggregate-only, no raw signer rows.

**Netlify:** do not set `VFM_DOTENV_PATH`. Set `DATABASE_URL`, `VFM_UPLOAD_TOKEN`, and other `VFM_*` values in the site environment. `OPENAI_API_KEY` is optional and not used for CSV/XLSX matching or the public reports UI.

## Deployment

- **Netlify** with **`@netlify/plugin-nextjs`** (see `netlify.toml`). The app is **Next.js**, not a legacy static site: the publish directory must be **`.next`**, not **`public/`**. The `public/` directory is only for static assets the framework serves; it is not the deploy output root.
- **Repository:** https://github.com/Grappe501/VoteMatch

## Copy tone for marketing pages

See **`LANDING_PAGE_COPY.md`** for neutral public wording where you want non-technical language.
