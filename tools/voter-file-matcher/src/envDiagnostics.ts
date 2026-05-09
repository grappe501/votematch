import { resolve } from "node:path";
import { loadVfmEnv } from "./env-load.js";
import { createPool } from "./db.js";

/** Safe env summary: no DATABASE_URL, file contents, or credentials. */
export function printEnvStatus(): void {
  loadVfmEnv();
  const rawDot = process.env.VFM_DOTENV_PATH?.trim() ?? "";
  const vfmDotenvPath = rawDot.length > 0 ? resolve(process.cwd(), rawDot) : null;
  console.log(
    JSON.stringify(
      {
        DATABASE_URL_configured: Boolean(process.env.DATABASE_URL?.trim()),
        VFM_DOTENV_PATH: vfmDotenvPath,
        VFM_PROJECT_KEY: process.env.VFM_PROJECT_KEY?.trim() ?? null,
        VFM_CANONICAL_TABLE: process.env.VFM_CANONICAL_TABLE?.trim() ?? null,
        VFM_MATCH_SOURCE_TABLE: process.env.VFM_MATCH_SOURCE_TABLE?.trim() ?? null,
        VFM_SOURCE_PROFILE_PATH: process.env.VFM_SOURCE_PROFILE_PATH?.trim() ?? null,
      },
      null,
      2
    )
  );
}

/** Trivial DB round-trip; never prints connection string or credentials. */
export async function runDbPing(): Promise<void> {
  loadVfmEnv();
  const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());
  const stamp = () => new Date().toISOString();

  if (!databaseConfigured) {
    console.log(
      JSON.stringify(
        {
          database_configured: false,
          connected: false,
          database_name: null,
          schema_name: null,
          checked_at: stamp(),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  const pool = createPool();
  try {
    const r = await pool.query<{ database_name: string; schema_name: string; checked_at: Date }>(
      `select current_database() as database_name, current_schema() as schema_name, now() as checked_at`
    );
    const row = r.rows[0];
    const checkedAt =
      row?.checked_at instanceof Date
        ? row.checked_at.toISOString()
        : row?.checked_at != null
          ? String(row.checked_at)
          : null;
    console.log(
      JSON.stringify(
        {
          database_configured: true,
          connected: true,
          database_name: row?.database_name ?? null,
          schema_name: row?.schema_name ?? null,
          checked_at: checkedAt,
        },
        null,
        2
      )
    );
  } catch {
    console.log(
      JSON.stringify(
        {
          database_configured: true,
          connected: false,
          database_name: null,
          schema_name: null,
          checked_at: stamp(),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
