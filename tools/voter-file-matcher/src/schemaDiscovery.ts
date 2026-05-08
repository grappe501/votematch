import type { Pool } from "pg";
import { parseQualifiedTable } from "./db.js";
import type {
  ColumnLogicalKind,
  SchemaColumnMeta,
  RelatedTableDiscovery,
  DiscoverVoterSchemaResult,
} from "./types.js";

function normCompact(name: string): string {
  return name.toLowerCase().replace(/[\s_]/g, "");
}

/** Single best-guess classification from column name only (no row data). */
export function classifyColumnName(columnName: string): ColumnLogicalKind {
  const n = normCompact(columnName);
  const el = columnName.toLowerCase();

  if (
    el === "updated_at" ||
    el === "modified_at" ||
    el === "last_updated" ||
    n === "updatedat" ||
    n === "modifiedat" ||
    n === "lastmodified"
  ) {
    return "updated_at_candidate";
  }
  if (n === "dob" || n === "dateofbirth" || n === "birthdate" || n === "birthdateonly" || el === "birth_date") {
    return "birth_date_candidate";
  }
  if (n === "birthyear" || n === "yob" || el === "birth_year") {
    return "birth_year_candidate";
  }
  if (n === "birthmonth" || el === "birth_month") {
    return "birth_month_candidate";
  }
  if (n === "birthday" || el === "birth_day") {
    return "birth_day_candidate";
  }
  if (
    n === "registrationnumber" ||
    n === "registrationid" ||
    n === "voterfilekey" ||
    n === "voterid" ||
    el === "voter_id" ||
    n === "vrn"
  ) {
    return "voter_id_candidate";
  }
  if (el === "id") {
    return "voter_id_candidate";
  }
  if (n === "firstname" || n === "fname" || el === "first_name" || n === "givenname") {
    return "first_name_candidate";
  }
  if (n === "lastname" || n === "lname" || el === "last_name" || n === "surname") {
    return "last_name_candidate";
  }
  if (n === "fullname" || el === "full_name" || n === "displayname" || el === "display_name" || el === "name") {
    return "full_name_candidate";
  }
  if (
    n === "residentialaddress" ||
    n === "residenceaddress" ||
    n === "streetaddress" ||
    n === "mailingaddress" ||
    el === "mailing_address" ||
    el === "street_address" ||
    el === "address" ||
    el === "address1" ||
    el === "address_line1"
  ) {
    return "address_candidate";
  }
  if (n === "residencecity" || n === "residentialcity" || n === "mailingcity" || el === "mailing_city" || el === "city") {
    return "city_candidate";
  }
  if (n === "countyname" || n === "residencecounty" || el === "county") {
    return "county_candidate";
  }
  if (el === "state" || n === "statecode" || el === "state_code") {
    return "state_candidate";
  }
  if (el === "zip" || n === "zipcode" || el === "zip_code" || n === "postalcode" || el === "postal_code") {
    return "zip_candidate";
  }
  if (
    el === "ward" ||
    n === "wardnumber" ||
    n === "wardname" ||
    el === "ward_name" ||
    el === "city_ward" ||
    el === "legislative_ward"
  ) {
    return "ward_candidate";
  }
  if (n === "precinct" || el === "precinct_name" || el === "precinctid" || n === "pct" || el === "election_precinct") {
    return "precinct_candidate";
  }
  if (el === "district" || n === "councildistrict" || el === "council_district" || el === "legislative_district") {
    return "district_candidate";
  }
  return "unknown";
}

const RELATED_TABLE_NAME_RE = /(voter|registration|constituent|person|resident|address|elect|roll|signer|household)/i;

const JOIN_KEY_NAME_RE = /(^id$|_id$|voter|registration|record|foreign|parent|person)/i;

export async function fetchTableColumnsMetadata(
  pool: Pool,
  tableSchema: string,
  tableName: string
): Promise<Omit<SchemaColumnMeta, "logical_classification">[]> {
  const r = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable::text AS is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [tableSchema, tableName]
  );
  return r.rows.map((row) => ({
    column_name: row.column_name,
    data_type: row.data_type,
    is_nullable: row.is_nullable === "YES" ? "YES" : "NO",
  }));
}

function qualify(schema: string, table: string): string {
  return `${schema}.${table}`;
}

export async function listPublicTables(pool: Pool): Promise<{ schema: string; table: string; table_type: string }[]> {
  const r = await pool.query<{ ts: string; tn: string; tt: string }>(
    `SELECT table_schema AS ts, table_name AS tn, table_type AS tt
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type IN ('BASE TABLE', 'VIEW')
     ORDER BY table_name`
  );
  return r.rows.map((x) => ({ schema: x.ts, table: x.tn, table_type: x.tt }));
}

function possibleJoinKeys(
  canonicalCols: SchemaColumnMeta[],
  relatedCols: SchemaColumnMeta[]
): RelatedTableDiscovery["possible_join_keys_with_canonical"] {
  const canonNames = new Set(canonicalCols.map((c) => c.column_name));
  const out: RelatedTableDiscovery["possible_join_keys_with_canonical"] = [];
  for (const rc of relatedCols) {
    if (!JOIN_KEY_NAME_RE.test(rc.column_name)) continue;
    if (canonNames.has(rc.column_name)) {
      out.push({
        canonical_column: rc.column_name,
        related_column: rc.column_name,
        hint: "same column name on both relations (verify FK semantics; name-only signal)",
      });
    }
  }
  const canonByNorm = new Map<string, string[]>();
  for (const c of canonicalCols) {
    const k = normCompact(c.column_name);
    const arr = canonByNorm.get(k) ?? [];
    arr.push(c.column_name);
    canonByNorm.set(k, arr);
  }
  for (const rc of relatedCols) {
    const nk = normCompact(rc.column_name);
    const matches = canonByNorm.get(nk);
    if (!matches?.length) continue;
    if (matches.includes(rc.column_name)) continue;
    for (const cc of matches) {
      out.push({
        canonical_column: cc,
        related_column: rc.column_name,
        hint: "normalized name match only; verify join cardinality",
      });
    }
  }
  return dedupeJoinHints(out);
}

function dedupeJoinHints(
  rows: RelatedTableDiscovery["possible_join_keys_with_canonical"]
): RelatedTableDiscovery["possible_join_keys_with_canonical"] {
  const seen = new Set<string>();
  const out: RelatedTableDiscovery["possible_join_keys_with_canonical"] = [];
  for (const r of rows) {
    const k = `${r.canonical_column}|${r.related_column}|${r.hint}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export async function discoverVoterSchema(
  pool: Pool,
  canonicalQualified: string,
  includeRelated: boolean
): Promise<DiscoverVoterSchemaResult> {
  const { schema, table } = parseQualifiedTable(canonicalQualified);
  const resolved_table = qualify(schema, table);
  const rawCols = await fetchTableColumnsMetadata(pool, schema, table);
  const columns: SchemaColumnMeta[] = rawCols.map((c) => ({
    ...c,
    logical_classification: classifyColumnName(c.column_name),
  }));

  let related_tables: RelatedTableDiscovery[] | undefined;
  if (includeRelated) {
    const all = await listPublicTables(pool);
    related_tables = [];
    for (const t of all) {
      const q = qualify(t.schema, t.table);
      if (q === resolved_table) continue;
      if (!RELATED_TABLE_NAME_RE.test(t.table)) {
        /* still might include by columns below */
      }
      const rc = await fetchTableColumnsMetadata(pool, t.schema, t.table);
      const rcm: SchemaColumnMeta[] = rc.map((c) => ({
        ...c,
        logical_classification: classifyColumnName(c.column_name),
      }));
      const interestingByName = RELATED_TABLE_NAME_RE.test(t.table);
      const interestingByCol = rcm.some((c) => c.logical_classification !== "unknown");
      if (!interestingByName && !interestingByCol) continue;

      const match_reason = interestingByName
        ? "table_name_suggests_voter_or_address_domain"
        : "column_names_suggest_voter_or_demographic_fields";

      related_tables.push({
        qualified_table: q,
        table_type: t.table_type,
        match_reason,
        columns: rcm,
        possible_join_keys_with_canonical: possibleJoinKeys(columns, rcm),
      });
    }
  }

  return {
    resolved_table,
    columns,
    related_tables,
  };
}
