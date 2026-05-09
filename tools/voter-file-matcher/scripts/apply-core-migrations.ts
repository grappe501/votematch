/**
 * Apply VoteMatch core migrations 001, 002, 004–007 in order (skips 003 template).
 * Uses DATABASE_URL from .env / VFM_DOTENV_PATH / RedDirt sibling (same as CLI).
 * Does not print connection strings.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadVfmEnv } from "../src/env-load.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const FILES = [
  "001_import_matcher_tables.sql",
  "002_review_resolution_audit.sql",
  "004_import_plan_guardrails.sql",
  "005_reporting_review_views.sql",
  "006_confidence_initiative_rollups.sql",
  "007_review_candidates_jurisdiction_nonvoters.sql",
] as const;

async function main(): Promise<void> {
  loadVfmEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is not set. Configure petition_match/.env or VFM_DOTENV_PATH.");
  }

  const migrationsDir = resolve(__dirname, "..", "migrations");
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    for (const name of FILES) {
      if (name === "006_confidence_initiative_rollups.sql") {
        await client.query("DROP VIEW IF EXISTS batch_review_queue_enriched CASCADE");
        await client.query("DROP VIEW IF EXISTS batch_signature_report_rows CASCADE");
      }
      const path = resolve(migrationsDir, name);
      const sql = readFileSync(path, "utf8");
      process.stderr.write(`Applying ${name} ...\n`);
      await client.query(sql);
      process.stderr.write(`OK ${name}\n`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  process.stderr.write("All listed migrations applied.\n");
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
