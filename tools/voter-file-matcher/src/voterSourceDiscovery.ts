/**
 * information_schema-only helpers for locating canonical voter tables (no row reads).
 */
import type { Pool } from "pg";
import { parseQualifiedTable } from "./db.js";
import { classifyColumnName } from "./schemaDiscovery.js";
import { relationExists } from "./matchSource.js";
import type { MatchSourcePlanJson } from "./types.js";

const TABLE_NAME_HINTS = [
  /voter/i,
  /voterrecord/i,
  /voter_file/i,
  /registration/i,
  /registr/i,
  /elect/i,
  /vrn/i,
];

const COLUMN_TOKEN_HINTS = [
  "voter",
  "voterrecord",
  "voterfile",
  "registration",
  "firstname",
  "lastname",
  "first_name",
  "last_name",
  "address",
  "birth",
  "ward",
  "precinct",
  "district",
  "county",
  "city",
  "zip",
];

function normToken(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]/g, "");
}

function scoreTable(tableName: string, columnNames: string[]): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const tn = tableName.toLowerCase();
  for (const re of TABLE_NAME_HINTS) {
    if (re.test(tn)) {
      score += 25;
      reasons.push(`table_name matches ${re.source}`);
      break;
    }
  }
  const colJoined = columnNames.join(" ").toLowerCase();
  for (const h of COLUMN_TOKEN_HINTS) {
    const compact = h.replace(/_/g, "");
    if (colJoined.includes(h) || normToken(colJoined).includes(compact)) {
      score += 4;
    }
  }
  const distinctHints = new Set<string>();
  for (const cn of columnNames) {
    const n = normToken(cn);
    for (const h of COLUMN_TOKEN_HINTS) {
      if (n.includes(h.replace(/_/g, ""))) distinctHints.add(h);
    }
  }
  if (distinctHints.size >= 4) {
    score += 15;
    reasons.push(`multiple demographic/geo tokens (${distinctHints.size})`);
  }
  if (distinctHints.has("ward") || distinctHints.has("precinct") || distinctHints.has("district")) {
    score += 8;
    reasons.push("geo / ward-like columns present");
  }
  return { score: Math.min(score, 100), reasons };
}

export type LikelyVoterTableRow = {
  schema: string;
  table_name: string;
  table_type: string;
  likely_score: number;
  likely_reason: string;
  candidate_columns: string[];
};

/**
 * List public tables/views that look voter-related (information_schema only).
 */
export async function discoverLikelyVoterTables(pool: Pool): Promise<LikelyVoterTableRow[]> {
  const r = await pool.query<{ table_name: string; table_type: string; cols: string | null }>(
    `SELECT t.table_name::text,
            t.table_type::text,
            string_agg(c.column_name::text, E'\\x1f' ORDER BY c.ordinal_position) AS cols
     FROM information_schema.tables t
     LEFT JOIN information_schema.columns c
       ON c.table_schema = t.table_schema AND c.table_name = t.table_name
     WHERE t.table_schema = 'public'
       AND t.table_type IN ('BASE TABLE', 'VIEW')
     GROUP BY t.table_name, t.table_type`
  );
  const rows: LikelyVoterTableRow[] = [];
  for (const row of r.rows) {
    const cols = row.cols ? row.cols.split("\x1f").filter(Boolean) : [];
    const { score, reasons } = scoreTable(row.table_name, cols);
    if (score <= 0) continue;
    rows.push({
      schema: "public",
      table_name: row.table_name,
      table_type: row.table_type,
      likely_score: score,
      likely_reason: reasons.length ? reasons.join("; ") : "heuristic match",
      candidate_columns: cols.slice(0, 40),
    });
  }
  rows.sort((a, b) => b.likely_score - a.likely_score || a.table_name.localeCompare(b.table_name));
  return rows.slice(0, 80);
}

export type InspectedColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  logical_meaning: string;
};

/**
 * Column metadata for a single qualified table (information_schema only).
 */
export type MatchSourceSuggestColumnSummary = {
  confidence: string;
  mapped: boolean;
  notes: string[];
};

/** Safe summary for CLI JSON (no raw SQL expressions). */
export function buildMatchSourceSuggestSummary(plan: MatchSourcePlanJson): Record<
  string,
  MatchSourceSuggestColumnSummary
> {
  const out: Record<string, MatchSourceSuggestColumnSummary> = {};
  for (const [k, v] of Object.entries(plan.standard_columns)) {
    out[k] = {
      confidence: v.confidence,
      mapped: Boolean(v.source_expression && v.source_expression.trim().length > 0),
      notes: v.notes,
    };
  }
  return out;
}

export async function inspectTableColumnsMetadata(pool: Pool, qualifiedTable: string): Promise<InspectedColumnRow[]> {
  parseQualifiedTable(qualifiedTable);
  const exists = await relationExists(pool, qualifiedTable);
  if (!exists) {
    throw new Error(`Table or view not found in information_schema: ${qualifiedTable}`);
  }
  const { schema, table } = parseQualifiedTable(qualifiedTable);
  const r = await pool.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    ordinal_position: number;
  }>(
    `SELECT column_name::text,
            data_type::text,
            is_nullable::text,
            ordinal_position
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table]
  );
  return r.rows.map((c) => ({
    column_name: c.column_name,
    data_type: c.data_type,
    is_nullable: c.is_nullable,
    logical_meaning: classifyColumnName(c.column_name),
  }));
}
