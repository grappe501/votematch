import type { Pool } from "pg";
import { createPool, fetchTableColumnNames, parseQualifiedTable } from "./db.js";
import { loadHeaderMapFile } from "./headerMap.js";
import { buildCanonicalColumnMap } from "./matcher.js";
import {
  relationExists,
  validateMatchSourceColumns,
  getMatchSourceMode,
  readMatchSourceTableEnv,
  type MatchSourceMode,
} from "./matchSource.js";
import type { VoterHeaderMapFile } from "./types.js";

const LEGACY_REQUIRED_HEADER_FIELDS = [
  "first_name",
  "last_name",
  "city",
  "county",
  "zip",
  "address",
  "voter_id",
] as const;

const MIGRATION_TABLES = [
  "import_batches",
  "import_files",
  "import_header_maps",
  "import_rows",
  "import_voter_matches",
  "petitions",
  "voter_petition_signatures",
  "import_reports",
] as const;

const MIGRATION_002_TABLES = ["import_match_reviews", "voter_petition_signature_events"] as const;

const MIGRATION_002_VIEWS = ["import_review_queue", "petition_signature_audit", "petition_city_counts"] as const;

export type ValidateConfigResult = {
  ok: boolean;
  database_url_configured: boolean;
  vfm_canonical_table_configured: boolean;
  vfm_match_source_table_configured: boolean;
  match_source_mode: MatchSourceMode;
  map_file: string;
  map_parse_ok: boolean;
  required_alias_fields: Record<string, boolean>;
  source_profile_path?: string | null;
  active_profile_name?: string | null;
  errors: string[];
};

export type ValidateDbResult = {
  ok: boolean;
  migration_tables: Record<string, boolean>;
  canonical_table_reachable: boolean;
  canonical_columns_ok?: boolean;
  missing_canonical_columns?: string[];
  canonical_column_warnings?: string[];
  match_source_table_reachable?: boolean;
  match_source_columns_ok?: boolean;
  missing_match_source_required?: string[];
  match_source_warnings?: string[];
  errors: string[];
  migration_002_objects?: Record<string, boolean>;
  migration_002_ok?: boolean;
  /** Present when DB was reachable: public.import_plans from migration 004. */
  migration_004_import_plans_present?: boolean;
  /** Non-fatal notes about optional migration 004. */
  plan_migration_notes?: string[];
  /** Objects from optional migration 005 (reporting / ward columns). */
  migration_005_objects?: Record<string, boolean>;
  migration_005_ok?: boolean;
  /** Objects from optional migration 006 (confidence %, initiative rollups). */
  migration_006_objects?: Record<string, boolean>;
  migration_006_ok?: boolean;
  /** Objects from optional migration 007 (review queue 80, nonvoters, candidate snapshots). */
  migration_007_objects?: Record<string, boolean>;
  migration_007_ok?: boolean;
  migration_007_notes?: string[];
};

function requiredHeaderFieldsForMap(map: VoterHeaderMapFile): readonly string[] {
  if (map.validation?.requiredHeaderFields && map.validation.requiredHeaderFields.length > 0) {
    return map.validation.requiredHeaderFields;
  }
  return LEGACY_REQUIRED_HEADER_FIELDS;
}

function physicalColumnHasMatch(cols: Set<string>, physical: string): boolean {
  if (cols.has(physical)) return true;
  const lower = physical.toLowerCase();
  for (const c of cols) {
    if (c.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Verify every physical column referenced in the map exists on the canonical table.
 * Returns missing entries as human-readable "logical (physicalName)" strings.
 */
export function validateCanonicalPhysicalColumns(
  map: VoterHeaderMapFile,
  dbColumns: Set<string>
): { ok: boolean; missing: string[]; warnings: string[] } {
  const missing: string[] = [];
  const warnings: string[] = [];
  const c = map.canonicalDatabase.columns;
  for (const [logical, physical] of Object.entries(c)) {
    if (!physical || typeof physical !== "string") continue;
    if (!physicalColumnHasMatch(dbColumns, physical)) {
      missing.push(`${logical} (expected column "${physical}")`);
    }
  }

  const tier = map.matching?.tierSet;
  if (tier === "petition_mail") {
    const needOptional = [
      { k: "birth_date", label: "tier 2 (name + birth date)" },
      { k: "birth_year", label: "tiers 3–4 (birth year + location)" },
      { k: "address", label: "tier 3 (address + zip)" },
      { k: "zip", label: "tiers 3–4 (ZIP)" },
      { k: "city", label: "tiers 4–5 (city)" },
    ] as const;
    for (const { k, label } of needOptional) {
      const phys = c[k];
      if (!phys || !physicalColumnHasMatch(dbColumns, phys)) {
        warnings.push(
          `Optional for ${label}: canonicalDatabase.columns.${k} is missing or not present on table — matching tiers that need it are skipped.`
        );
      }
    }
  }

  return { ok: missing.length === 0, missing, warnings };
}

export async function runValidateConfig(mapPath: string): Promise<ValidateConfigResult> {
  const errors: string[] = [];
  const database_url_configured = Boolean(process.env.DATABASE_URL?.trim());
  const vfm_canonical_table_configured = Boolean(process.env.VFM_CANONICAL_TABLE?.trim());
  const vfm_match_source_table_configured = Boolean(process.env.VFM_MATCH_SOURCE_TABLE?.trim());
  const match_source_mode = getMatchSourceMode();

  if (!vfm_canonical_table_configured && !vfm_match_source_table_configured) {
    errors.push(
      "Set at least one of VFM_CANONICAL_TABLE or VFM_MATCH_SOURCE_TABLE (canonical is still recommended for imports and FK alignment)."
    );
  }

  let map_parse_ok = false;
  const required_alias_fields: Record<string, boolean> = {};
  let active_profile_name: string | null = null;

  try {
    const map = await loadHeaderMapFile(mapPath);
    map_parse_ok = true;
    active_profile_name = map.profileName?.trim() ? map.profileName!.trim() : null;
    const required = requiredHeaderFieldsForMap(map);
    for (const key of required) {
      const list = map.headerAliases[key];
      const posCovers =
        map.columnPositions &&
        Object.values(map.columnPositions).some((logical) => logical === key);
      const ok = (Array.isArray(list) && list.length > 0) || Boolean(posCovers);
      required_alias_fields[key] = ok;
      if (!ok) {
        errors.push(
          `Required import field "${key}" must have headerAliases.${key} as a non-empty array and/or columnPositions mapping to "${key}".`
        );
      }
    }
    try {
      buildCanonicalColumnMap(map);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`canonical column map invalid: ${msg}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Map file error: ${msg}`);
  }

  const ok = errors.length === 0 && map_parse_ok;
  const envProfile = process.env.VFM_SOURCE_PROFILE_PATH?.trim();
  // Path of the map/profile file this validation run used (CLI --map/--profile or default).
  const source_profile_path = mapPath || envProfile || undefined;

  return {
    ok,
    database_url_configured,
    vfm_canonical_table_configured,
    vfm_match_source_table_configured,
    match_source_mode,
    map_file: mapPath,
    map_parse_ok,
    required_alias_fields,
    source_profile_path,
    active_profile_name: active_profile_name || undefined,
    errors,
  };
}

export async function runValidateDb(mapPath: string): Promise<ValidateDbResult> {
  const errors: string[] = [];
  const migration_tables: Record<string, boolean> = {};
  const canonicalWarnings: string[] = [];
  const ct = process.env.VFM_CANONICAL_TABLE?.trim() || "";
  const ms = readMatchSourceTableEnv() || "";

  if (!process.env.DATABASE_URL?.trim()) {
    errors.push("DATABASE_URL is not set; cannot run --validate-db.");
    return {
      ok: false,
      migration_tables,
      canonical_table_reachable: false,
      errors,
      migration_002_objects: {},
      migration_002_ok: false,
      migration_005_objects: {},
      migration_005_ok: false,
      migration_006_objects: {},
      migration_006_ok: false,
      migration_007_objects: {},
      migration_007_ok: false,
    };
  }

  if (!ct && !ms) {
    errors.push("Set VFM_CANONICAL_TABLE and/or VFM_MATCH_SOURCE_TABLE for --validate-db.");
    return {
      ok: false,
      migration_tables,
      canonical_table_reachable: false,
      errors,
      migration_002_objects: {},
      migration_002_ok: false,
      migration_005_objects: {},
      migration_005_ok: false,
      migration_006_objects: {},
      migration_006_ok: false,
      migration_007_objects: {},
      migration_007_ok: false,
    };
  }

  let map: VoterHeaderMapFile;
  try {
    map = await loadHeaderMapFile(mapPath);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      migration_tables,
      canonical_table_reachable: false,
      errors,
      migration_002_objects: {},
      migration_002_ok: false,
      migration_005_objects: {},
      migration_005_ok: false,
      migration_006_objects: {},
      migration_006_ok: false,
      migration_007_objects: {},
      migration_007_ok: false,
    };
  }

  let pool: Pool | null = null;
  let canonical_table_reachable = false;
  let canonical_columns_ok: boolean | undefined = undefined;
  const missing_canonical_columns: string[] = [];
  let match_source_table_reachable: boolean | undefined = undefined;
  let match_source_columns_ok: boolean | undefined = undefined;
  const missing_match_source_required: string[] = [];
  const match_source_warnings: string[] = [];
  const migration_002_objects: Record<string, boolean> = {};
  try {
    pool = createPool();
    for (const tbl of MIGRATION_TABLES) {
      const r = await pool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS e`,
        [tbl]
      );
      migration_tables[tbl] = Boolean(r.rows[0]?.e);
      if (!migration_tables[tbl]) {
        errors.push(`Missing table public.${tbl} (apply migrations/001_import_matcher_tables.sql).`);
      }
    }

    const tables001Ok = MIGRATION_TABLES.every((t) => migration_tables[t]);

    for (const tbl of MIGRATION_002_TABLES) {
      const r = await pool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS e`,
        [tbl]
      );
      migration_002_objects[`table:${tbl}`] = Boolean(r.rows[0]?.e);
      if (!migration_002_objects[`table:${tbl}`]) {
        errors.push(`Missing table public.${tbl} (apply migrations/002_review_resolution_audit.sql).`);
      }
    }

    const colReview = await pool.query<{ e: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'import_voter_matches' AND column_name = 'review_status'
       ) AS e`
    );
    migration_002_objects["column:import_voter_matches.review_status"] = Boolean(colReview.rows[0]?.e);
    if (!migration_002_objects["column:import_voter_matches.review_status"]) {
      errors.push(
        "Missing column public.import_voter_matches.review_status (apply migrations/002_review_resolution_audit.sql)."
      );
    }

    for (const v of MIGRATION_002_VIEWS) {
      const r = await pool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.views
           WHERE table_schema = 'public' AND table_name = $1
         ) AS e`,
        [v]
      );
      migration_002_objects[`view:${v}`] = Boolean(r.rows[0]?.e);
      if (!migration_002_objects[`view:${v}`]) {
        errors.push(`Missing view public.${v} (apply migrations/002_review_resolution_audit.sql).`);
      }
    }

    const migration_002_ok = Object.values(migration_002_objects).every(Boolean);
    if (tables001Ok && !migration_002_ok) {
      errors.push(
        "Migration 001 appears present, but review/audit objects are missing. Apply tools/voter-file-matcher/migrations/002_review_resolution_audit.sql."
      );
    }

    if (ct) {
      try {
        const { schema, table } = parseQualifiedTable(ct);
        const tr = await pool.query<{ e: boolean }>(
          `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = $2
         ) AS e`,
          [schema, table]
        );
        canonical_table_reachable = Boolean(tr.rows[0]?.e);
        if (!canonical_table_reachable) {
          errors.push(`Canonical table not found: ${ct} (check VFM_CANONICAL_TABLE and identifier spelling).`);
        } else {
          const colSet = await fetchTableColumnNames(pool, ct);
          const colCheck = validateCanonicalPhysicalColumns(map, colSet);
          canonical_columns_ok = colCheck.ok;
          missing_canonical_columns.push(...colCheck.missing);
          canonicalWarnings.push(...colCheck.warnings);
          for (const m of colCheck.missing) {
            errors.push(`Canonical table is missing mapped column for: ${m}`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Canonical table check failed: ${msg}`);
      }
    } else {
      canonicalWarnings.push("VFM_CANONICAL_TABLE is not set; canonical table / column DDL checks were skipped.");
      canonical_table_reachable = false;
      canonical_columns_ok = undefined;
    }

    if (ms) {
      try {
        match_source_table_reachable = await relationExists(pool, ms);
        if (!match_source_table_reachable) {
          errors.push(`Match source table or view not found: ${ms}`);
          match_source_columns_ok = false;
        } else {
          const mCols = await fetchTableColumnNames(pool, ms);
          const mv = validateMatchSourceColumns(mCols);
          match_source_columns_ok = mv.ok;
          missing_match_source_required.push(...mv.required_missing);
          match_source_warnings.push(...mv.recommended_missing.map((c) => `Recommended match-source column missing: ${c}`));
          if (!mv.ok) {
            for (const c of mv.required_missing) {
              errors.push(`Match source is missing required column: ${c}`);
            }
          }
          if (map.matching?.tierSet === "petition_mail") {
            const need = ["birth_date", "birth_year", "address_norm", "city_norm", "zip5"] as const;
            const missingPet = need.filter((k) => mv.recommended_missing.includes(k));
            if (missingPet.length) {
              match_source_warnings.push(
                `Petition mail matching may be weak or skip tiers until these match-source columns exist: ${missingPet.join(", ")}.`
              );
            }
          }
          if (mv.ward_reporting_missing.length >= 6) {
            match_source_warnings.push(
              "Ward reporting: no ward / precinct / district columns detected on VFM_MATCH_SOURCE_TABLE. Matched rows will roll up to ward UNKNOWN until the match source exposes ward or district fields."
            );
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Match source check failed: ${msg}`);
      }
    }

    if (!ms && map.profileName === "petition-mail-list-share-v1") {
      canonicalWarnings.push(
        "Active profile is petition-mail-list-share-v1 but VFM_MATCH_SOURCE_TABLE is not set: direct VoterRecord matching may fail unless canonical columns expose DOB, address, and ZIP."
      );
    }

    const r004 = await pool.query<{ e: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'import_plans'
       ) AS e`
    );
    const migration_004_import_plans_present = Boolean(r004.rows[0]?.e);
    const plan_migration_notes: string[] = [];
    if (tables001Ok && migration_002_ok && !migration_004_import_plans_present) {
      plan_migration_notes.push(
        "Migration 004_import_plan_guardrails.sql is missing. Apply it to enable guarded production import plans."
      );
    }

    const migration_005_objects: Record<string, boolean> = {};
    const colWard = await pool.query<{ e: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'voter_petition_signatures' AND column_name = 'voter_ward'
       ) AS e`
    );
    migration_005_objects["column:voter_petition_signatures.voter_ward"] = Boolean(colWard.rows[0]?.e);
    for (const v of ["batch_signature_report_rows", "batch_review_queue_enriched", "petition_ward_signature_counts"] as const) {
      const rv = await pool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.views
           WHERE table_schema = 'public' AND table_name = $1
         ) AS e`,
        [v]
      );
      migration_005_objects[`view:${v}`] = Boolean(rv.rows[0]?.e);
    }
    const migration_005_ok = Object.values(migration_005_objects).every(Boolean);
    if (tables001Ok && migration_002_ok && !migration_005_ok) {
      plan_migration_notes.push(
        "Migration 005_reporting_review_views.sql is missing. Apply it for operator reports, ward columns, and batch_review_queue_enriched."
      );
    }

    const migration_006_objects: Record<string, boolean> = {};
    const dbPool = pool as Pool;
    const markCol = async (table: string, column: string, key: string) => {
      const r = await dbPool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
         ) AS e`,
        [table, column]
      );
      migration_006_objects[key] = Boolean(r.rows[0]?.e);
    };
    await markCol("import_voter_matches", "match_confidence_pct", "column:import_voter_matches.match_confidence_pct");
    await markCol("voter_petition_signatures", "match_confidence_pct", "column:voter_petition_signatures.match_confidence_pct");
    await markCol("petitions", "initiative_scope", "column:petitions.initiative_scope");
    await markCol("petitions", "reporting_geo", "column:petitions.reporting_geo");
    for (const v of [
      "initiative_signature_rollup",
      "initiative_ward_counts",
      "initiative_county_counts",
      "initiative_review_confidence_queue",
    ] as const) {
      const rv = await dbPool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.views
           WHERE table_schema = 'public' AND table_name = $1
         ) AS e`,
        [v]
      );
      migration_006_objects[`view:${v}`] = Boolean(rv.rows[0]?.e);
    }
    const migration_006_ok = Object.values(migration_006_objects).every(Boolean);
    const migration_006_notes: string[] = [];
    if (tables001Ok && migration_002_ok && !migration_006_ok) {
      migration_006_notes.push(
        "Migration 006_confidence_initiative_rollups.sql is missing or incomplete. Confidence percentages and initiative rollup views will not be available until it is applied."
      );
    }

    if (ms && migration_006_ok) {
      const mCols = await fetchTableColumnNames(dbPool, ms);
      const low = new Set([...mCols].map((c: string) => c.toLowerCase()));
      const petRg = await dbPool.query<{ reporting_geo: string | null }>(
        `SELECT reporting_geo FROM public.petitions WHERE reporting_geo IS NOT NULL LIMIT 1`
      );
      const sampleGeo = petRg.rows[0]?.reporting_geo?.toUpperCase() ?? "";
      if (sampleGeo === "WARD" && !["ward", "ward_norm", "district", "district_norm"].some((c) => low.has(c))) {
        match_source_warnings.push(
          "At least one petition has reporting_geo WARD but VFM_MATCH_SOURCE_TABLE has no ward/district columns; ward rollups will skew UNKNOWN."
        );
      }
      if (
        sampleGeo === "COUNTY" &&
        !["county", "county_norm"].some((c) => low.has(c))
      ) {
        match_source_warnings.push(
          "At least one petition has reporting_geo COUNTY but match source lacks county columns; verify signer_county on imports."
        );
      }
    }

    plan_migration_notes.push(...migration_006_notes);

    const migration_007_objects: Record<string, boolean> = {};
    let migration_007_ok = false;
    const migration_007_notes: string[] = [];
    const mark007 = async (table: string, column: string, key: string) => {
      const r = await dbPool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
         ) AS e`,
        [table, column]
      );
      migration_007_objects[key] = Boolean(r.rows[0]?.e);
    };
    await mark007("petitions", "review_confidence_threshold", "column:petitions.review_confidence_threshold");
    await mark007("petitions", "jurisdiction_city", "column:petitions.jurisdiction_city");
    await mark007("import_voter_matches", "is_in_review_queue", "column:import_voter_matches.is_in_review_queue");
    await mark007("import_voter_matches", "jurisdiction_status", "column:import_voter_matches.jurisdiction_status");
    await mark007("voter_petition_signatures", "jurisdiction_status", "column:voter_petition_signatures.jurisdiction_status");
    for (const t of ["initiative_nonvoter_entries", "review_candidate_snapshots"] as const) {
      const tr = await dbPool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS e`,
        [t]
      );
      migration_007_objects[`table:${t}`] = Boolean(tr.rows[0]?.e);
    }
    for (const v of ["initiative_review_queue_80", "initiative_nonvoter_summary", "initiative_duplicate_summary"] as const) {
      const vr = await dbPool.query<{ e: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.views
           WHERE table_schema = 'public' AND table_name = $1
         ) AS e`,
        [v]
      );
      migration_007_objects[`view:${v}`] = Boolean(vr.rows[0]?.e);
    }
    migration_007_ok = Object.values(migration_007_objects).every(Boolean);
    if (tables001Ok && migration_002_ok && !migration_007_ok) {
      migration_007_notes.push(
        "Migration 007_review_candidates_jurisdiction_nonvoters.sql is missing or incomplete. Review-candidate snapshots, nonvoter entries, and initiative_review_queue_80 will not be available until it is applied."
      );
    }
    if (migration_007_ok) {
      const cityInit = await dbPool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM petitions p
         WHERE (p.initiative_scope = 'CITY' OR p.jurisdiction_type = 'CITY')
           AND (p.jurisdiction_city IS NULL OR btrim(p.jurisdiction_city) = ''
             OR p.jurisdiction_state IS NULL OR btrim(p.jurisdiction_state) = '')`
      );
      const n = Number.parseInt(cityInit.rows[0]?.c ?? "0", 10);
      if (n > 0) {
        migration_007_notes.push(
          `${n} CITY-scoped initiative(s) lack jurisdiction_city/state; imports may require --confirm-missing-jurisdiction until fields are set via --upsert-initiative.`
        );
      }
    }
    plan_migration_notes.push(...migration_007_notes);

    const tablesOk = MIGRATION_TABLES.every((t) => migration_tables[t]);
    const canonicalOk = !ct || (canonical_table_reachable && canonical_columns_ok === true);
    const matchOk = !ms || match_source_columns_ok === true;
    const ok = errors.length === 0 && tablesOk && canonicalOk && matchOk && migration_002_ok;

    return {
      ok,
      migration_tables,
      canonical_table_reachable,
      canonical_columns_ok,
      missing_canonical_columns: missing_canonical_columns.length ? missing_canonical_columns : undefined,
      canonical_column_warnings: canonicalWarnings.length ? canonicalWarnings : undefined,
      match_source_table_reachable,
      match_source_columns_ok,
      missing_match_source_required: missing_match_source_required.length
        ? missing_match_source_required
        : undefined,
      match_source_warnings: match_source_warnings.length ? match_source_warnings : undefined,
      errors,
      migration_002_objects,
      migration_002_ok,
      migration_004_import_plans_present,
      plan_migration_notes: plan_migration_notes.length ? plan_migration_notes : undefined,
      migration_005_objects,
      migration_005_ok,
      migration_006_objects,
      migration_006_ok,
      migration_007_objects,
      migration_007_ok,
      migration_007_notes: migration_007_notes.length ? migration_007_notes : undefined,
    };
  } finally {
    await pool?.end().catch(() => undefined);
  }
}
