import type { PoolClient } from "pg";
import type { CanonicalColumnMap, MatchOutcome, NormalizedRowJson, VoterHeaderMapFile } from "./types.js";
import { colExpr, assertSqlIdent, qualifiedTableSql } from "./db.js";
import { matchPetitionMailOnMatchSource, readMatchSourceTableEnv } from "./matchSource.js";

export function buildCanonicalColumnMap(file: VoterHeaderMapFile): CanonicalColumnMap {
  const c = file.canonicalDatabase.columns;
  const req = ["id", "first_name", "last_name", "county"] as const;
  for (const k of req) {
    const v = c[k];
    if (!v || typeof v !== "string") {
      throw new Error(`canonicalDatabase.columns.${k} is required`);
    }
  }
  const out: CanonicalColumnMap = {
    id: assertSqlIdent(c.id!, "canonical id"),
    first_name: assertSqlIdent(c.first_name!, "canonical first_name"),
    last_name: assertSqlIdent(c.last_name!, "canonical last_name"),
    county: assertSqlIdent(c.county!, "canonical county"),
  };
  const opt = (k: string) => {
    const v = c[k];
    if (v && typeof v === "string") (out as Record<string, string>)[k] = assertSqlIdent(v, `canonical ${k}`);
  };
  opt("voter_id");
  opt("external_voter_id");
  opt("state_voter_id");
  opt("birth_date");
  opt("birth_year");
  opt("address");
  opt("zip");
  opt("city");
  return out;
}

function sqlNormAddr(colSql: string): string {
  return `regexp_replace(lower(btrim(${colSql}::text)), '[^a-z0-9]', '', 'g')`;
}

function sqlZip5(colSql: string): string {
  return `CASE WHEN length(regexp_replace(btrim(${colSql}::text), '[^0-9]', '', 'g')) >= 5
    THEN substring(regexp_replace(btrim(${colSql}::text), '[^0-9]', '', 'g') from 1 for 5)
    ELSE NULL END`;
}

async function selectDistinctIds(client: PoolClient, sql: string, params: unknown[]): Promise<string[]> {
  const r = await client.query<{ id: string }>(sql, params);
  return r.rows.map((x) => x.id);
}

async function matchTier1(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  const idCol = cols.id;
  const ors: string[] = [];
  const params: unknown[] = [];
  let n = 1;

  const add = (fragment: string, val: unknown) => {
    if (val == null || String(val).trim() === "") return;
    ors.push(fragment.replace(/__P__/g, () => `$${n++}`));
    params.push(val);
  };

  if (row.voter_id) {
    add(`lower(btrim(${colExpr(qt, idCol)}::text)) = lower(btrim(__P__::text))`, row.voter_id);
    if (cols.voter_id && cols.voter_id !== idCol) {
      add(`lower(btrim(${colExpr(qt, cols.voter_id)}::text)) = lower(btrim(__P__::text))`, row.voter_id);
    }
  }
  if (row.external_voter_id && cols.external_voter_id) {
    add(`lower(btrim(${colExpr(qt, cols.external_voter_id)}::text)) = lower(btrim(__P__::text))`, row.external_voter_id);
  }
  if (row.state_voter_id && cols.state_voter_id) {
    add(`lower(btrim(${colExpr(qt, cols.state_voter_id)}::text)) = lower(btrim(__P__::text))`, row.state_voter_id);
  }

  if (ors.length === 0) return [];

  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE (${ors.join(" OR ")})
  `;
  return selectDistinctIds(client, sql, params);
}

async function matchTier2Default(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  if (!cols.birth_date || !row.birth_date || !row.first_name || !row.last_name || !row.county) return [];
  const idCol = cols.id;
  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE lower(btrim(${colExpr(qt, cols.first_name)}::text)) = $1
      AND lower(btrim(${colExpr(qt, cols.last_name)}::text)) = $2
      AND ${colExpr(qt, cols.birth_date)}::date = $3::date
      AND lower(btrim(${colExpr(qt, cols.county)}::text)) = $4
  `;
  return selectDistinctIds(client, sql, [row.first_name, row.last_name, row.birth_date, row.county]);
}

/** Petition mail: name + birth date (no county on sheet / not required for this tier). */
async function matchTier2PetitionMail(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  if (!cols.birth_date || !row.birth_date || !row.first_name || !row.last_name) return [];
  const idCol = cols.id;
  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE lower(btrim(${colExpr(qt, cols.first_name)}::text)) = $1
      AND lower(btrim(${colExpr(qt, cols.last_name)}::text)) = $2
      AND ${colExpr(qt, cols.birth_date)}::date = $3::date
  `;
  return selectDistinctIds(client, sql, [row.first_name, row.last_name, row.birth_date]);
}

async function matchTier3Default(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  if (!cols.birth_year || row.birth_year == null || !row.first_name || !row.last_name || !row.county) return [];
  const idCol = cols.id;
  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE lower(btrim(${colExpr(qt, cols.first_name)}::text)) = $1
      AND lower(btrim(${colExpr(qt, cols.last_name)}::text)) = $2
      AND ${colExpr(qt, cols.birth_year)}::int = $3
      AND lower(btrim(${colExpr(qt, cols.county)}::text)) = $4
  `;
  return selectDistinctIds(client, sql, [row.first_name, row.last_name, row.birth_year, row.county]);
}

/** Petition mail: name + birth year + normalized address + ZIP5. */
async function matchTier3PetitionMail(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  if (
    !cols.birth_year ||
    !cols.address ||
    !cols.zip ||
    row.birth_year == null ||
    !row.address ||
    !row.zip ||
    !row.first_name ||
    !row.last_name
  ) {
    return [];
  }
  const idCol = cols.id;
  const addrCol = colExpr(qt, cols.address);
  const zipCol = colExpr(qt, cols.zip);
  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE lower(btrim(${colExpr(qt, cols.first_name)}::text)) = $1
      AND lower(btrim(${colExpr(qt, cols.last_name)}::text)) = $2
      AND ${colExpr(qt, cols.birth_year)}::int = $3
      AND ${sqlNormAddr(addrCol)} = $4
      AND ${sqlZip5(zipCol)} = $5
  `;
  return selectDistinctIds(client, sql, [row.first_name, row.last_name, row.birth_year, row.address, row.zip]);
}

async function matchTier4Default(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  if (!cols.address || !cols.zip || !row.address || !row.zip || !row.first_name || !row.last_name) return [];
  const idCol = cols.id;
  const addrCol = colExpr(qt, cols.address);
  const zipCol = colExpr(qt, cols.zip);
  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE lower(btrim(${colExpr(qt, cols.first_name)}::text)) = $1
      AND lower(btrim(${colExpr(qt, cols.last_name)}::text)) = $2
      AND ${sqlNormAddr(addrCol)} = $3
      AND ${sqlZip5(zipCol)} = $4
  `;
  return selectDistinctIds(client, sql, [row.first_name, row.last_name, row.address, row.zip]);
}

/** Petition mail: name + birth year + city + ZIP5. */
async function matchTier4PetitionMail(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  if (
    !cols.birth_year ||
    !cols.city ||
    !cols.zip ||
    row.birth_year == null ||
    !row.city ||
    !row.zip ||
    !row.first_name ||
    !row.last_name
  ) {
    return [];
  }
  const idCol = cols.id;
  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE lower(btrim(${colExpr(qt, cols.first_name)}::text)) = $1
      AND lower(btrim(${colExpr(qt, cols.last_name)}::text)) = $2
      AND ${colExpr(qt, cols.birth_year)}::int = $3
      AND lower(btrim(${colExpr(qt, cols.city)}::text)) = $4
      AND ${sqlZip5(colExpr(qt, cols.zip))} = $5
  `;
  return selectDistinctIds(client, sql, [row.first_name, row.last_name, row.birth_year, row.city, row.zip]);
}

async function matchTier5DefaultWeak(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  if (!cols.city || !row.first_name || !row.last_name || !row.city || !row.county) return [];
  const idCol = cols.id;
  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE lower(btrim(${colExpr(qt, cols.first_name)}::text)) = $1
      AND lower(btrim(${colExpr(qt, cols.last_name)}::text)) = $2
      AND lower(btrim(${colExpr(qt, cols.city)}::text)) = $3
      AND lower(btrim(${colExpr(qt, cols.county)}::text)) = $4
  `;
  return selectDistinctIds(client, sql, [row.first_name, row.last_name, row.city, row.county]);
}

/** Petition mail weak: first + last + city only (sheet has no reliable county). */
async function matchTier5PetitionMailWeak(
  client: PoolClient,
  qt: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson
): Promise<string[]> {
  if (!cols.city || !row.first_name || !row.last_name || !row.city) return [];
  const idCol = cols.id;
  const sql = `
    SELECT DISTINCT ${colExpr(qt, idCol)}::text AS id
    FROM ${qt}
    WHERE lower(btrim(${colExpr(qt, cols.first_name)}::text)) = $1
      AND lower(btrim(${colExpr(qt, cols.last_name)}::text)) = $2
      AND lower(btrim(${colExpr(qt, cols.city)}::text)) = $3
  `;
  return selectDistinctIds(client, sql, [row.first_name, row.last_name, row.city]);
}

function isPetitionMailTierSet(map: VoterHeaderMapFile | undefined): boolean {
  return map?.matching?.tierSet === "petition_mail";
}

export async function matchNormalizedRow(
  client: PoolClient,
  canonicalTableQualified: string,
  cols: CanonicalColumnMap,
  row: NormalizedRowJson,
  headerMap?: VoterHeaderMapFile
): Promise<MatchOutcome> {
  const petition = isPetitionMailTierSet(headerMap);
  const ms = readMatchSourceTableEnv();
  if (ms && petition) {
    return matchPetitionMailOnMatchSource(client, ms, row);
  }

  const qt = qualifiedTableSql(canonicalTableQualified);
  try {
    const t1 = await matchTier1(client, qt, cols, row);
    if (t1.length > 1) {
      return {
        status: "MULTIPLE_MATCHES",
        matchMethod: "tier1_ids",
        matchConfidence: null,
        voterId: null,
        candidateIds: t1,
        notes: null,
      };
    }
    if (t1.length === 1) {
      return {
        status: "MATCHED",
        matchMethod: "tier1_ids",
        matchConfidence: 1,
        voterId: t1[0]!,
        candidateIds: t1,
        notes: null,
      };
    }

    const t2 = petition
      ? await matchTier2PetitionMail(client, qt, cols, row)
      : await matchTier2Default(client, qt, cols, row);
    if (t2.length > 1) {
      return {
        status: "MULTIPLE_MATCHES",
        matchMethod: petition ? "tier2_name_birth_date" : "tier2_name_birth_date_county",
        matchConfidence: null,
        voterId: null,
        candidateIds: t2,
        notes: null,
      };
    }
    if (t2.length === 1) {
      return {
        status: "MATCHED",
        matchMethod: petition ? "tier2_name_birth_date" : "tier2_name_birth_date_county",
        matchConfidence: petition ? 0.94 : 0.95,
        voterId: t2[0]!,
        candidateIds: t2,
        notes: null,
      };
    }

    const t3 = petition
      ? await matchTier3PetitionMail(client, qt, cols, row)
      : await matchTier3Default(client, qt, cols, row);
    if (t3.length > 1) {
      return {
        status: "MULTIPLE_MATCHES",
        matchMethod: petition ? "tier3_name_birth_year_address_zip" : "tier3_name_birth_year_county",
        matchConfidence: null,
        voterId: null,
        candidateIds: t3,
        notes: null,
      };
    }
    if (t3.length === 1) {
      return {
        status: "MATCHED",
        matchMethod: petition ? "tier3_name_birth_year_address_zip" : "tier3_name_birth_year_county",
        matchConfidence: petition ? 0.9 : 0.9,
        voterId: t3[0]!,
        candidateIds: t3,
        notes: null,
      };
    }

    const t4 = petition
      ? await matchTier4PetitionMail(client, qt, cols, row)
      : await matchTier4Default(client, qt, cols, row);
    if (t4.length > 1) {
      return {
        status: "MULTIPLE_MATCHES",
        matchMethod: petition ? "tier4_name_birth_year_city_zip" : "tier4_name_address_zip",
        matchConfidence: null,
        voterId: null,
        candidateIds: t4,
        notes: null,
      };
    }
    if (t4.length === 1) {
      return {
        status: "MATCHED",
        matchMethod: petition ? "tier4_name_birth_year_city_zip" : "tier4_name_address_zip",
        matchConfidence: petition ? 0.86 : 0.85,
        voterId: t4[0]!,
        candidateIds: t4,
        notes: null,
      };
    }

    const t5 = petition
      ? await matchTier5PetitionMailWeak(client, qt, cols, row)
      : await matchTier5DefaultWeak(client, qt, cols, row);
    if (t5.length > 1) {
      return {
        status: "MULTIPLE_MATCHES",
        matchMethod: petition ? "tier5_name_city_weak" : "tier5_name_city_county_weak",
        matchConfidence: null,
        voterId: null,
        candidateIds: t5,
        notes: null,
      };
    }
    if (t5.length === 1) {
      return {
        status: "WEAK_MATCH",
        matchMethod: petition ? "tier5_name_city_weak" : "tier5_name_city_county_weak",
        matchConfidence: 0.5,
        voterId: t5[0]!,
        candidateIds: t5,
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
