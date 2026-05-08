import type { Pool, PoolClient } from "pg";
import type {
  CandidateProbeSummary,
  MatchOutcome,
  NormalizedRowJson,
  ParsedSheet,
  PreflightSummaryJson,
  VoterHeaderMapFile,
} from "./types.js";
import { buildCanonicalColumnMap, matchNormalizedRow } from "./matcher.js";
import { processMappedRow } from "./rowPipeline.js";
import {
  assertSqlIdent,
  colExpr,
  qualifiedTableSql,
  parseQualifiedTable,
  fetchTableColumnNames,
} from "./db.js";

export type MatchSourceMode = "match_source" | "canonical_table";

/** Standard logical columns on VFM_MATCH_SOURCE_TABLE / view. */
export const STANDARD_MATCH_SOURCE_COLUMNS = [
  "voter_id",
  "first_name",
  "last_name",
  "first_name_norm",
  "last_name_norm",
  "birth_date",
  "birth_year",
  "address",
  "address_norm",
  "city",
  "city_norm",
  "county",
  "county_norm",
  "state",
  "zip",
  "zip5",
  "source_updated_at",
  "source_metadata",
  "ward",
  "ward_norm",
  "precinct",
  "precinct_norm",
  "district",
  "district_norm",
  "jurisdiction_city",
  "jurisdiction_county",
  "jurisdiction_state",
  "municipality",
  "city_limits_flag",
] as const;

export type StandardMatchSourceColumn = (typeof STANDARD_MATCH_SOURCE_COLUMNS)[number];

const REQUIRED_MATCH_SOURCE = ["voter_id", "first_name_norm", "last_name_norm"] as const;

const RECOMMENDED_PETITION = [
  "birth_date",
  "birth_year",
  "address_norm",
  "city_norm",
  "state",
  "zip5",
] as const;

/** Optional geo fields for ward / reporting (not required for matching). */
const WARD_REPORTING_OPTIONAL = [
  "ward",
  "ward_norm",
  "precinct",
  "precinct_norm",
  "district",
  "district_norm",
] as const;

/** Raw env value for VFM_MATCH_SOURCE_TABLE (trimmed) or null if unset. */
export function readMatchSourceTableEnv(): string | null {
  const v = process.env.VFM_MATCH_SOURCE_TABLE?.trim();
  return v && v.length > 0 ? v : null;
}

export function getMatchSourceMode(): MatchSourceMode {
  return readMatchSourceTableEnv() ? "match_source" : "canonical_table";
}

/**
 * Table or view used for voter candidate matching SQL.
 * Returns VFM_MATCH_SOURCE_TABLE when set, otherwise the canonical qualified table.
 */
export function resolveMatchSourceTable(canonicalQualified: string): string {
  const ms = readMatchSourceTableEnv();
  if (ms) return ms;
  return canonicalQualified;
}

/** @alias resolveMatchSourceTable */
export function resolveMatchQueryQualifiedTable(canonicalQualified: string): string {
  return resolveMatchSourceTable(canonicalQualified);
}

export function getStandardMatchColumns(): readonly StandardMatchSourceColumn[] {
  return STANDARD_MATCH_SOURCE_COLUMNS;
}

function msCol(qt: string, col: string): string {
  return colExpr(qt, assertSqlIdent(col, `match source ${col}`));
}

export type MatchSourceColumnValidation = {
  ok: boolean;
  required_missing: string[];
  recommended_missing: string[];
  /** Optional ward / precinct / district columns missing on match source (reporting hints only). */
  ward_reporting_missing: string[];
  present: string[];
};

export function validateMatchSourceColumns(dbColumns: Set<string>): MatchSourceColumnValidation {
  const present: string[] = [];
  const required_missing: string[] = [];
  const recommended_missing: string[] = [];
  const ward_reporting_missing: string[] = [];

  const has = (name: string) => {
    if (dbColumns.has(name)) return true;
    const lower = name.toLowerCase();
    for (const c of dbColumns) {
      if (c.toLowerCase() === lower) return true;
    }
    return false;
  };

  for (const c of STANDARD_MATCH_SOURCE_COLUMNS) {
    if (has(c)) present.push(c);
  }
  for (const c of REQUIRED_MATCH_SOURCE) {
    if (!has(c)) required_missing.push(c);
  }
  for (const c of RECOMMENDED_PETITION) {
    if (!has(c)) recommended_missing.push(c);
  }
  for (const c of WARD_REPORTING_OPTIONAL) {
    if (!has(c)) ward_reporting_missing.push(c);
  }

  return {
    ok: required_missing.length === 0,
    required_missing,
    recommended_missing,
    ward_reporting_missing,
    present: [...new Set(present)].sort(),
  };
}

export type SafeColumnPresenceReport = {
  match_source_mode: MatchSourceMode;
  resolved_table: string;
  standard_columns_expected: readonly string[];
  columns_present: string[];
  required_missing: string[];
  recommended_missing: string[];
  ward_reporting_missing: string[];
};

export function safeColumnPresenceReport(
  resolvedTableQualified: string,
  dbColumns: Set<string>
): SafeColumnPresenceReport {
  const v = validateMatchSourceColumns(dbColumns);
  return {
    match_source_mode: readMatchSourceTableEnv() ? "match_source" : "canonical_table",
    resolved_table: resolvedTableQualified,
    standard_columns_expected: [...STANDARD_MATCH_SOURCE_COLUMNS],
    columns_present: v.present,
    required_missing: v.required_missing,
    recommended_missing: v.recommended_missing,
    ward_reporting_missing: v.ward_reporting_missing,
  };
}

/**
 * Build parameterized WHERE clause bodies (without leading WHERE) for each
 * petition-mail tier on the standard match source. Intended for documentation
 * and tests; runtime matching uses dedicated SQL in `matchPetitionMailOnMatchSource`.
 */
export function buildMatchSourceWhereClauses(): {
  tier: number;
  columns_used: string[];
  predicate_summary: string;
}[] {
  return [
    { tier: 1, columns_used: ["voter_id"], predicate_summary: "voter_id equals import id(s)" },
    {
      tier: 2,
      columns_used: ["first_name_norm", "last_name_norm", "birth_date"],
      predicate_summary: "name norms + birth_date",
    },
    {
      tier: 3,
      columns_used: ["first_name_norm", "last_name_norm", "birth_year", "address_norm", "zip5"],
      predicate_summary: "name norms + birth_year + address_norm + zip5",
    },
    {
      tier: 4,
      columns_used: ["first_name_norm", "last_name_norm", "birth_year", "city_norm", "zip5"],
      predicate_summary: "name norms + birth_year + city_norm + zip5",
    },
    {
      tier: 5,
      columns_used: ["first_name_norm", "last_name_norm", "city_norm"],
      predicate_summary: "name norms + city_norm (weak)",
    },
  ];
}

async function selectDistinctVoterIds(client: PoolClient, sql: string, params: unknown[]): Promise<string[]> {
  const r = await client.query<{ id: string }>(sql, params);
  return r.rows.map((x) => x.id);
}

async function tier1MatchSource(client: PoolClient, qt: string, row: NormalizedRowJson): Promise<string[]> {
  const vid = msCol(qt, "voter_id");
  const parts: string[] = [];
  const params: unknown[] = [];
  let n = 1;
  const add = (val: string | null | undefined) => {
    const t = val?.trim();
    if (!t) return;
    parts.push(`lower(btrim(${vid}::text)) = lower(btrim($${n++}::text))`);
    params.push(t);
  };
  add(row.voter_id);
  add(row.external_voter_id);
  add(row.state_voter_id);
  if (parts.length === 0) return [];
  const sql = `SELECT DISTINCT ${vid}::text AS id FROM ${qt} WHERE (${parts.join(" OR ")})`;
  return selectDistinctVoterIds(client, sql, params);
}

async function tier2MatchSource(client: PoolClient, qt: string, row: NormalizedRowJson): Promise<string[]> {
  if (!row.first_name || !row.last_name || !row.birth_date) return [];
  const fn = msCol(qt, "first_name_norm");
  const ln = msCol(qt, "last_name_norm");
  const bd = msCol(qt, "birth_date");
  const vid = msCol(qt, "voter_id");
  const sql = `
    SELECT DISTINCT ${vid}::text AS id
    FROM ${qt}
    WHERE ${fn} = $1 AND ${ln} = $2 AND ${bd}::date = $3::date
  `;
  return selectDistinctVoterIds(client, sql, [row.first_name, row.last_name, row.birth_date]);
}

async function tier3MatchSource(client: PoolClient, qt: string, row: NormalizedRowJson): Promise<string[]> {
  if (
    row.birth_year == null ||
    !row.address ||
    !row.zip ||
    !row.first_name ||
    !row.last_name
  ) {
    return [];
  }
  const fn = msCol(qt, "first_name_norm");
  const ln = msCol(qt, "last_name_norm");
  const by = msCol(qt, "birth_year");
  const an = msCol(qt, "address_norm");
  const z5 = msCol(qt, "zip5");
  const vid = msCol(qt, "voter_id");
  const sql = `
    SELECT DISTINCT ${vid}::text AS id
    FROM ${qt}
    WHERE ${fn} = $1 AND ${ln} = $2 AND ${by}::int = $3 AND ${an} = $4 AND ${z5} = $5
  `;
  return selectDistinctVoterIds(client, sql, [row.first_name, row.last_name, row.birth_year, row.address, row.zip]);
}

async function tier4MatchSource(client: PoolClient, qt: string, row: NormalizedRowJson): Promise<string[]> {
  if (row.birth_year == null || !row.city || !row.zip || !row.first_name || !row.last_name) return [];
  const fn = msCol(qt, "first_name_norm");
  const ln = msCol(qt, "last_name_norm");
  const by = msCol(qt, "birth_year");
  const cn = msCol(qt, "city_norm");
  const z5 = msCol(qt, "zip5");
  const vid = msCol(qt, "voter_id");
  const sql = `
    SELECT DISTINCT ${vid}::text AS id
    FROM ${qt}
    WHERE ${fn} = $1 AND ${ln} = $2 AND ${by}::int = $3 AND ${cn} = $4 AND ${z5} = $5
  `;
  return selectDistinctVoterIds(client, sql, [row.first_name, row.last_name, row.birth_year, row.city, row.zip]);
}

async function tier5MatchSourceWeak(client: PoolClient, qt: string, row: NormalizedRowJson): Promise<string[]> {
  if (!row.first_name || !row.last_name || !row.city) return [];
  const fn = msCol(qt, "first_name_norm");
  const ln = msCol(qt, "last_name_norm");
  const cn = msCol(qt, "city_norm");
  const vid = msCol(qt, "voter_id");
  const sql = `
    SELECT DISTINCT ${vid}::text AS id
    FROM ${qt}
    WHERE ${fn} = $1 AND ${ln} = $2 AND ${cn} = $3
  `;
  return selectDistinctVoterIds(client, sql, [row.first_name, row.last_name, row.city]);
}

function outcomeFromTier(
  ids: string[],
  statusMatched: "MATCHED" | "MULTIPLE_MATCHES" | "WEAK_MATCH",
  method: string,
  confidence: number | null
): MatchOutcome {
  if (ids.length > 1) {
    return {
      status: "MULTIPLE_MATCHES",
      matchMethod: method,
      matchConfidence: null,
      voterId: null,
      candidateIds: ids,
      notes: null,
    };
  }
  if (ids.length === 1) {
    return {
      status: statusMatched,
      matchMethod: method,
      matchConfidence: confidence,
      voterId: ids[0]!,
      candidateIds: ids,
      notes: null,
    };
  }
  return {
    status: "NOT_FOUND",
    matchMethod: null,
    matchConfidence: null,
    voterId: null,
    candidateIds: [],
    notes: null,
  };
}

/** Petition-mail matching against standard match-source columns only. */
export async function matchPetitionMailOnMatchSource(
  client: PoolClient,
  matchTableQualified: string,
  row: NormalizedRowJson
): Promise<MatchOutcome> {
  const qt = qualifiedTableSql(matchTableQualified);
  try {
    const t1 = await tier1MatchSource(client, qt, row);
    const o1 = outcomeFromTier(t1, "MATCHED", "match_source_tier1_voter_id", 1);
    if (o1.status !== "NOT_FOUND") return o1;

    const t2 = await tier2MatchSource(client, qt, row);
    const o2 = outcomeFromTier(t2, "MATCHED", "match_source_tier2_name_birth_date", 0.94);
    if (o2.status !== "NOT_FOUND") return o2;

    const t3 = await tier3MatchSource(client, qt, row);
    const o3 = outcomeFromTier(t3, "MATCHED", "match_source_tier3_name_yob_address_zip5", 0.9);
    if (o3.status !== "NOT_FOUND") return o3;

    const t4 = await tier4MatchSource(client, qt, row);
    const o4 = outcomeFromTier(t4, "MATCHED", "match_source_tier4_name_yob_city_zip5", 0.86);
    if (o4.status !== "NOT_FOUND") return o4;

    const t5 = await tier5MatchSourceWeak(client, qt, row);
    const o5 = outcomeFromTier(t5, "WEAK_MATCH", "match_source_tier5_name_city_weak", 0.5);
    if (o5.status !== "NOT_FOUND") return o5;

    return {
      status: "NOT_FOUND",
      matchMethod: null,
      matchConfidence: null,
      voterId: null,
      candidateIds: [],
      notes: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "ERROR",
      matchMethod: null,
      matchConfidence: null,
      voterId: null,
      candidateIds: [],
      notes: msg.slice(0, 4000),
    };
  }
}

export async function assertVoterExistsInMatchSourceOrCanonical(
  client: PoolClient,
  opts: {
    voterId: string;
    canonicalTableQualified: string;
    cols: import("./types.js").CanonicalColumnMap;
  }
): Promise<void> {
  const ms = readMatchSourceTableEnv();
  if (ms) {
    const qt = qualifiedTableSql(ms);
    const vid = msCol(qt, "voter_id");
    const r = await client.query<{ ok: string }>(
      `SELECT ${vid}::text AS ok FROM ${qt} WHERE lower(btrim(${vid}::text)) = lower(btrim($1::text)) LIMIT 1`,
      [opts.voterId.trim()]
    );
    if (r.rows.length === 0) {
      throw new Error(`voter_id not found in match source: ${opts.voterId}`);
    }
    return;
  }
  const cq = opts.canonicalTableQualified?.trim();
  if (!cq) {
    throw new Error("VFM_CANONICAL_TABLE is required when VFM_MATCH_SOURCE_TABLE is not set.");
  }
  const qt = qualifiedTableSql(cq);
  const idCol = opts.cols.id;
  const r = await client.query<{ ok: string }>(
    `SELECT ${colExpr(qt, idCol)}::text AS ok FROM ${qt} WHERE ${colExpr(qt, idCol)}::text = $1 LIMIT 1`,
    [opts.voterId.trim()]
  );
  if (r.rows.length === 0) {
    throw new Error(`voter_id not found in canonical table: ${opts.voterId}`);
  }
}

export type VoterGeoSnapshot = {
  voter_ward: string | null;
  voter_precinct: string | null;
  voter_district: string | null;
};

function pickExistingColumn(cols: Set<string>, candidates: readonly string[]): string | null {
  for (const c of candidates) {
    if (cols.has(c)) return c;
    const low = c.toLowerCase();
    for (const x of cols) {
      if (x.toLowerCase() === low) return x;
    }
  }
  return null;
}

/**
 * Reads optional ward / precinct / district from the resolved match source (or canonical) row for a voter_id.
 * Returns nulls when columns are absent or values are empty.
 */
export async function fetchVoterGeoForVoterId(
  client: Pick<PoolClient, "query">,
  opts: { qualifiedTable: string; voterId: string }
): Promise<VoterGeoSnapshot> {
  const cols = await fetchTableColumnNames(client, opts.qualifiedTable);
  const qt = qualifiedTableSql(opts.qualifiedTable);
  const vidCol = pickExistingColumn(cols, ["voter_id"]);
  if (!vidCol) {
    return { voter_ward: null, voter_precinct: null, voter_district: null };
  }
  const wCol = pickExistingColumn(cols, ["ward", "ward_norm"]);
  const pCol = pickExistingColumn(cols, ["precinct", "precinct_norm"]);
  const dCol = pickExistingColumn(cols, ["district", "district_norm"]);
  if (!wCol && !pCol && !dCol) {
    return { voter_ward: null, voter_precinct: null, voter_district: null };
  }
  const vidExpr = msCol(qt, vidCol);
  const wExpr = wCol ? `${colExpr(qt, wCol)}::text` : `NULL::text`;
  const pExpr = pCol ? `${colExpr(qt, pCol)}::text` : `NULL::text`;
  const dExpr = dCol ? `${colExpr(qt, dCol)}::text` : `NULL::text`;
  const r = await client.query<{ voter_ward: string | null; voter_precinct: string | null; voter_district: string | null }>(
    `SELECT ${wExpr} AS voter_ward, ${pExpr} AS voter_precinct, ${dExpr} AS voter_district
     FROM ${qt}
     WHERE lower(btrim(${vidExpr}::text)) = lower(btrim($1::text))
     LIMIT 1`,
    [opts.voterId.trim()]
  );
  const row = r.rows[0];
  return {
    voter_ward: row?.voter_ward?.trim() ? row.voter_ward : null,
    voter_precinct: row?.voter_precinct?.trim() ? row.voter_precinct : null,
    voter_district: row?.voter_district?.trim() ? row.voter_district : null,
  };
}

/** City / county / state (and ward geo) for jurisdiction checks; nulls when columns missing. */
export type VoterLocationSnapshot = {
  city: string | null;
  county: string | null;
  state: string | null;
  ward: string | null;
  precinct: string | null;
  district: string | null;
};

export async function fetchVoterLocationSnapshot(
  client: Pick<PoolClient, "query">,
  opts: { qualifiedTable: string; voterId: string }
): Promise<VoterLocationSnapshot> {
  const empty: VoterLocationSnapshot = {
    city: null,
    county: null,
    state: null,
    ward: null,
    precinct: null,
    district: null,
  };
  const cols = await fetchTableColumnNames(client, opts.qualifiedTable);
  const qt = qualifiedTableSql(opts.qualifiedTable);
  const vidCol = pickExistingColumn(cols, ["voter_id"]);
  if (!vidCol) return empty;

  const cn = pickExistingColumn(cols, ["jurisdiction_city", "municipality", "city_norm", "city"]);
  const co = pickExistingColumn(cols, ["jurisdiction_county", "county_norm", "county"]);
  const st = pickExistingColumn(cols, ["jurisdiction_state", "state"]);
  const wCol = pickExistingColumn(cols, ["ward", "ward_norm"]);
  const pCol = pickExistingColumn(cols, ["precinct", "precinct_norm"]);
  const dCol = pickExistingColumn(cols, ["district", "district_norm"]);

  const vidExpr = colExpr(qt, assertSqlIdent(vidCol, "voter_id"));
  const cExpr = cn ? `${colExpr(qt, assertSqlIdent(cn, "city"))}::text` : `NULL::text`;
  const coExpr = co ? `${colExpr(qt, assertSqlIdent(co, "county"))}::text` : `NULL::text`;
  const stExpr = st ? `${colExpr(qt, assertSqlIdent(st, "state"))}::text` : `NULL::text`;
  const wExpr = wCol ? `${colExpr(qt, assertSqlIdent(wCol, "ward"))}::text` : `NULL::text`;
  const pExpr = pCol ? `${colExpr(qt, assertSqlIdent(pCol, "precinct"))}::text` : `NULL::text`;
  const dExpr = dCol ? `${colExpr(qt, assertSqlIdent(dCol, "district"))}::text` : `NULL::text`;

  const r = await client.query<{
    city: string | null;
    county: string | null;
    state: string | null;
    ward: string | null;
    precinct: string | null;
    district: string | null;
  }>(
    `SELECT ${cExpr} AS city, ${coExpr} AS county, ${stExpr} AS state,
            ${wExpr} AS ward, ${pExpr} AS precinct, ${dExpr} AS district
     FROM ${qt}
     WHERE lower(btrim(${vidExpr}::text)) = lower(btrim($1::text))
     LIMIT 1`,
    [opts.voterId.trim()]
  );
  const row = r.rows[0];
  if (!row) return empty;
  const t = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
  return {
    city: t(row.city),
    county: t(row.county),
    state: t(row.state),
    ward: t(row.ward),
    precinct: t(row.precinct),
    district: t(row.district),
  };
}

export async function inspectVoterMatchSource(pool: Pool): Promise<{
  source_mode: MatchSourceMode;
  resolved_table: string;
  relation_exists: boolean;
  column_names: string[];
  standard_column_report: SafeColumnPresenceReport;
}> {
  const ms = readMatchSourceTableEnv();
  const ct = process.env.VFM_CANONICAL_TABLE?.trim() || "";
  const resolved = (ms || ct).trim();
  if (!resolved) {
    throw new Error("Set VFM_MATCH_SOURCE_TABLE or VFM_CANONICAL_TABLE.");
  }
  const relation_exists = await relationExists(pool, resolved);
  const columnSet = await fetchTableColumnNames(pool, resolved);
  const column_names = [...columnSet].sort();
  const standard_column_report = safeColumnPresenceReport(resolved, columnSet);
  return {
    source_mode: getMatchSourceMode(),
    resolved_table: resolved,
    relation_exists,
    column_names,
    standard_column_report,
  };
}

export async function relationExists(pool: Pool, qualified: string): Promise<boolean> {
  const { schema, table } = parseQualifiedTable(qualified);
  const r = await pool.query<{ e: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = $2
     ) OR EXISTS (
       SELECT 1 FROM information_schema.views
       WHERE table_schema = $1 AND table_name = $2
     ) AS e`,
    [schema, table]
  );
  return Boolean(r.rows[0]?.e);
}

export type MatchReadinessResult = {
  file_preflight_ready: boolean;
  db_match_source_ready: boolean;
  projected_matching_quality: "strong" | "partial" | "weak" | "not_ready";
  reasons: string[];
  row_count: number;
  mapped_fields: string[];
  qa_counts: Record<string, number>;
  match_source_mode: MatchSourceMode;
  missing_required_db_fields: string[];
  missing_recommended_db_fields: string[];
  /** Present when produced by evaluateMatchReadiness (import plans). */
  suggested_next_steps?: string[];
};

export function computeProjectedMatchingQuality(args: {
  preflight_ready: boolean;
  file_has_first_last: boolean;
  file_has_birth_date: boolean;
  file_has_birth_year: boolean;
  file_has_address_signal: boolean;
  file_has_city: boolean;
  file_has_zip: boolean;
  db_required_ok: boolean;
  db_has_birth_date: boolean;
  db_has_birth_year: boolean;
  db_has_address_norm: boolean;
  db_has_city_norm: boolean;
  db_has_zip5: boolean;
}): { quality: "strong" | "partial" | "weak" | "not_ready"; reasons: string[] } {
  const reasons: string[] = [];
  if (!args.preflight_ready) {
    reasons.push("file_preflight_not_ready");
    return { quality: "not_ready", reasons };
  }
  if (!args.file_has_first_last) {
    reasons.push("file_missing_first_or_last_name_mapping");
    return { quality: "not_ready", reasons };
  }
  if (!args.db_required_ok) {
    reasons.push("match_source_missing_required_columns");
    return { quality: "not_ready", reasons };
  }

  const fileLoc =
    (args.file_has_address_signal || args.file_has_city) &&
    (args.file_has_zip || args.file_has_city);

  const fileStrongDob = args.file_has_birth_date || args.file_has_birth_year;

  const dbStrong =
    args.db_has_birth_date &&
    args.db_has_address_norm &&
    args.db_has_zip5 &&
    args.db_has_city_norm;

  const dbPartial =
    args.db_has_birth_year &&
    args.db_has_city_norm &&
    (!args.db_has_address_norm || !args.db_has_zip5 || !args.db_has_birth_date);

  if (fileStrongDob && fileLoc && dbStrong) {
    return { quality: "strong", reasons: ["file_and_db_support_tier2_through_tier4_style_matching"] };
  }

  if (fileStrongDob && fileLoc && dbPartial) {
    reasons.push("db_missing_some_location_or_birth_date_columns");
    return { quality: "partial", reasons };
  }

  if (
    args.file_has_first_last &&
    args.file_has_city &&
    args.db_has_city_norm &&
    args.db_required_ok
  ) {
    reasons.push("relying_primarily_on_name_plus_city_norm_tier");
    return { quality: "weak", reasons };
  }

  reasons.push("insufficient_file_or_db_alignment_for_confident_matching");
  return { quality: "not_ready", reasons };
}

/** Match-readiness evaluation for import plans (no file I/O; uses preflight summary + DB metadata). */
export async function evaluateMatchReadiness(
  pool: Pool,
  pf: PreflightSummaryJson,
  mapFile: VoterHeaderMapFile
): Promise<MatchReadinessResult> {
  const ms = readMatchSourceTableEnv();
  let db_match_source_ready = true;
  let missing_required_db_fields: string[] = [];
  let missing_recommended_db_fields: string[] = [];
  let mv: MatchSourceColumnValidation | null = null;
  if (ms) {
    const ex = await relationExists(pool, ms);
    if (!ex) {
      db_match_source_ready = false;
      missing_required_db_fields.push("(relation not found)");
    } else {
      const cols = await fetchTableColumnNames(pool, ms);
      mv = validateMatchSourceColumns(cols);
      db_match_source_ready = mv.ok;
      missing_required_db_fields = mv.required_missing;
      missing_recommended_db_fields = mv.recommended_missing;
    }
  }
  const ne = pf.non_empty_counts_by_field;
  const nz = (k: string) => (ne[k] ?? 0) > 0;
  const pset = new Set(mv?.present ?? []);
  const hasP = (c: string) => pset.has(c);
  const { quality, reasons } = ms
    ? computeProjectedMatchingQuality({
        preflight_ready: pf.ready_for_import,
        file_has_first_last: nz("first_name") && nz("last_name"),
        file_has_birth_date: nz("birth_date"),
        file_has_birth_year: nz("birth_year"),
        file_has_address_signal: nz("address"),
        file_has_city: nz("city"),
        file_has_zip: nz("zip"),
        db_required_ok: db_match_source_ready,
        db_has_birth_date: hasP("birth_date"),
        db_has_birth_year: hasP("birth_year"),
        db_has_address_norm: hasP("address_norm"),
        db_has_city_norm: hasP("city_norm"),
        db_has_zip5: hasP("zip5"),
      })
    : {
        quality: pf.ready_for_import ? ("weak" as const) : ("not_ready" as const),
        reasons: [
          "VFM_MATCH_SOURCE_TABLE is not set; matcher will use canonical table only (install a match source view for stronger petition matching).",
        ],
      };

  const suggested_next_steps: string[] = [];
  const petitionMail = mapFile.matching?.tierSet === "petition_mail";
  const dbFieldsGap =
    ms &&
    (!db_match_source_ready ||
      missing_required_db_fields.length > 0 ||
      missing_recommended_db_fields.length > 0);
  if (!ms && petitionMail && quality !== "strong") {
    suggested_next_steps.push(
      "Set VFM_MATCH_SOURCE_TABLE=public.voter_match_source after creating the match-source view."
    );
  }
  if (ms && dbFieldsGap) {
    suggested_next_steps.push(
      "Run --discover-voter-schema and --plan-match-source to update the view mapping."
    );
  }

  return {
    file_preflight_ready: pf.ready_for_import,
    db_match_source_ready: ms ? db_match_source_ready : true,
    projected_matching_quality: quality,
    reasons,
    row_count: pf.row_count,
    mapped_fields: pf.mapped_fields,
    qa_counts: pf.qa_counts,
    match_source_mode: getMatchSourceMode(),
    missing_required_db_fields: ms ? missing_required_db_fields : [],
    missing_recommended_db_fields: ms ? missing_recommended_db_fields : [],
    suggested_next_steps,
  };
}

/** Aggregate-only candidate probe for import plans (no row logging). */
export async function evaluateCandidateProbe(
  pool: Pool,
  canonicalTableQualified: string,
  mapFile: VoterHeaderMapFile,
  sheet: ParsedSheet,
  limit: number
): Promise<CandidateProbeSummary> {
  const cols = buildCanonicalColumnMap(mapFile);
  const lim = Number.isFinite(limit) && limit > 0 ? limit : 25;
  const sample: { normalized: NormalizedRowJson }[] = [];
  for (let i = 0; i < sheet.rows.length && sample.length < lim; i++) {
    const cells = sheet.rows[i]!;
    const { normalized } = processMappedRow(mapFile, sheet.headers, cells);
    sample.push({ normalized });
  }
  const c = await pool.connect();
  try {
    let matched = 0;
    let not_found = 0;
    let multiple_matches = 0;
    let weak_matches = 0;
    let errors = 0;
    const match_methods: Record<string, number> = {};
    for (const row of sample) {
      const outcome = await matchNormalizedRow(c, canonicalTableQualified, cols, row.normalized, mapFile);
      if (outcome.matchMethod) {
        match_methods[outcome.matchMethod] = (match_methods[outcome.matchMethod] ?? 0) + 1;
      }
      if (outcome.status === "MATCHED") matched += 1;
      else if (outcome.status === "NOT_FOUND") not_found += 1;
      else if (outcome.status === "MULTIPLE_MATCHES") multiple_matches += 1;
      else if (outcome.status === "WEAK_MATCH") weak_matches += 1;
      else if (outcome.status === "ERROR") errors += 1;
    }
    return {
      sampled_rows: sample.length,
      matched,
      not_found,
      multiple_matches,
      weak_matches,
      errors,
      match_methods,
    };
  } finally {
    c.release();
  }
}
