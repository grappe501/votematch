import type { Pool } from "pg";
import pg from "pg";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Strip optional double quotes from a single schema or table segment (e.g. `"VoterRecord"`). */
export function stripQuotedIdentSegment(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

export function assertSqlIdent(name: string, label: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid ${label} identifier "${name}"`);
  }
  return name;
}

export function parseQualifiedTable(qualified: string): { schema: string; table: string } {
  const parts = qualified.split(".").map((p) => stripQuotedIdentSegment(p)).filter(Boolean);
  if (parts.length === 1) {
    return { schema: "public", table: assertSqlIdent(parts[0]!, "table") };
  }
  if (parts.length === 2) {
    return {
      schema: assertSqlIdent(parts[0]!, "schema"),
      table: assertSqlIdent(parts[1]!, "table"),
    };
  }
  throw new Error(`Table must be "table" or "schema.table", got: ${qualified}`);
}

export function qualifiedTableSql(qualified: string): string {
  const { schema, table } = parseQualifiedTable(qualified);
  return `"${schema}"."${table}"`;
}

export function colExpr(qt: string, physical: string): string {
  const c = assertSqlIdent(physical, "column");
  return `${qt}."${c}"`;
}

export function createPool(): pg.Pool {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is not set (check .env or VFM_DOTENV_PATH / RedDirt fallback).");
  }
  return new pg.Pool({ connectionString: url, max: 8 });
}

/** Column names on a table or view (information_schema). */
export async function fetchTableColumnNames(
  pool: Pick<Pool, "query">,
  qualifiedTable: string
): Promise<Set<string>> {
  const { schema, table } = parseQualifiedTable(qualifiedTable);
  const r = await pool.query<{ cn: string }>(
    `SELECT column_name AS cn
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return new Set(r.rows.map((x) => x.cn));
}
