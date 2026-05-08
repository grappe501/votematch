import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Load env for the voter matcher CLI.
 * 1. `.env` in the current working directory (typically `petition_match/`).
 * 2. If `VFM_DOTENV_PATH` is set, load that file next (override=true so it wins).
 * 3. Else if `DATABASE_URL` is still missing, try `../RedDirt/.env` then `./RedDirt/.env`
 *    (so a run from `petition_match/` picks up `H:\\SOSWebsite\\RedDirt\\.env` without duplicating secrets).
 */
export function loadVfmEnv(): void {
  loadDotenv();

  const extra = process.env.VFM_DOTENV_PATH?.trim();
  if (extra) {
    const resolved = resolve(process.cwd(), extra);
    if (existsSync(resolved)) {
      loadDotenv({ path: resolved, override: true });
    }
    return;
  }

  if (process.env.DATABASE_URL?.trim()) {
    return;
  }

  const candidates = [
    resolve(process.cwd(), "..", "RedDirt", ".env"),
    resolve(process.cwd(), "RedDirt", ".env"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      loadDotenv({ path: p });
      break;
    }
  }
}
