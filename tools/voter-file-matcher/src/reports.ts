import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Default JSON path for a prepared guarded import plan (under reports/, gitignored). */
export function defaultImportPlanOutPath(planKey: string): string {
  return join(process.cwd(), "tools", "voter-file-matcher", "reports", "import-plans", `${planKey}.json`);
}
import type { Pool } from "pg";
import type { CsvReportRow, QaFlagsCsvRow, SummaryReportJson } from "./types.js";

export function escapeCsvCell(v: string | boolean): string {
  const s = typeof v === "boolean" ? (v ? "true" : "false") : v;
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowToCsvLine(r: CsvReportRow): string {
  const cells = [
    String(r.row_number),
    r.match_status,
    r.voter_id,
    String(r.candidate_count),
    r.match_confidence_pct == null ? "" : String(r.match_confidence_pct),
    r.signer_first_name,
    r.signer_last_name,
    r.signer_city,
    r.signer_county,
    r.signer_address,
    r.signer_zip,
    r.notes,
  ];
  return cells.map((c) => escapeCsvCell(c ?? "")).join(",");
}

const CSV_HEADER =
  "row_number,match_status,voter_id,candidate_count,match_confidence_pct,signer_first_name,signer_last_name,signer_city,signer_county,signer_address,signer_zip,notes";

export function csvFromRows(rows: CsvReportRow[]): string {
  return [CSV_HEADER, ...rows.map(rowToCsvLine)].join("\n") + "\n";
}

const QA_CSV_HEADER =
  "row_number,qa_flags,first_name_present,last_name_present,address_present,city,state,zip,signed_at,notes_present,match_status,review_status,voter_id";

function qaRowToLine(r: QaFlagsCsvRow): string {
  return [
    String(r.row_number),
    r.qa_flags,
    r.first_name_present,
    r.last_name_present,
    r.address_present,
    r.city,
    r.state,
    r.zip,
    r.signed_at,
    r.notes_present,
    r.match_status,
    r.review_status,
    r.voter_id,
  ]
    .map((c) => escapeCsvCell(c as string | boolean))
    .join(",");
}

export function csvFromQaRows(rows: QaFlagsCsvRow[]): string {
  return [QA_CSV_HEADER, ...rows.map(qaRowToLine)].join("\n") + "\n";
}

export async function writeLocalReportFiles(
  batchId: string,
  files: {
    summary: SummaryReportJson;
    matched: CsvReportRow[];
    notFound: CsvReportRow[];
    multiple: CsvReportRow[];
    weak: CsvReportRow[];
    errors: CsvReportRow[];
    qaFlags?: QaFlagsCsvRow[];
  }
): Promise<string> {
  const base = join(process.cwd(), "tools", "voter-file-matcher", "reports", batchId);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "summary.json"), JSON.stringify(files.summary, null, 2), "utf8");
  await writeFile(join(base, "matched.csv"), csvFromRows(files.matched), "utf8");
  await writeFile(join(base, "not_found.csv"), csvFromRows(files.notFound), "utf8");
  await writeFile(join(base, "multiple_matches.csv"), csvFromRows(files.multiple), "utf8");
  await writeFile(join(base, "weak_matches.csv"), csvFromRows(files.weak), "utf8");
  await writeFile(join(base, "errors.csv"), csvFromRows(files.errors), "utf8");
  if (files.qaFlags != null) {
    await writeFile(join(base, "qa_flags.csv"), csvFromQaRows(files.qaFlags), "utf8");
  }
  return base;
}

export async function insertSummaryReport(pool: Pool, batchId: string, summary: SummaryReportJson): Promise<void> {
  await pool.query(
    `INSERT INTO import_reports (import_batch_id, report_type, report_json)
     VALUES ($1, 'SUMMARY', $2::jsonb)`,
    [batchId, JSON.stringify(summary)]
  );
}

export async function aggregateCityCounty(
  pool: Pool,
  batchId: string
): Promise<{ byCity: Record<string, number>; byCounty: Record<string, number> }> {
  const city = await pool.query<{ k: string; c: string }>(
    `SELECT COALESCE(NULLIF(btrim(ir.normalized_json->>'city'), ''), '(unknown)') AS k,
            COUNT(*)::text AS c
     FROM import_voter_matches mr
     INNER JOIN import_rows ir ON ir.id = mr.import_row_id
     WHERE mr.import_batch_id = $1 AND mr.match_status = 'MATCHED'
     GROUP BY 1`,
    [batchId]
  );
  const byCity: Record<string, number> = {};
  for (const row of city.rows) {
    byCity[row.k] = Number.parseInt(row.c, 10);
  }

  const county = await pool.query<{ k: string; c: string }>(
    `SELECT COALESCE(NULLIF(btrim(ir.normalized_json->>'county'), ''), '(unknown)') AS k,
            COUNT(*)::text AS c
     FROM import_voter_matches mr
     INNER JOIN import_rows ir ON ir.id = mr.import_row_id
     WHERE mr.import_batch_id = $1 AND mr.match_status = 'MATCHED'
     GROUP BY 1`,
    [batchId]
  );
  const byCounty: Record<string, number> = {};
  for (const row of county.rows) {
    byCounty[row.k] = Number.parseInt(row.c, 10);
  }

  return { byCity, byCounty };
}

export async function aggregateByChunk(pool: Pool, batchId: string): Promise<Record<string, Record<string, number>>> {
  const r = await pool.query<{ chunk: string; status: string; c: string }>(
    `SELECT ir.chunk_number::text AS chunk, mr.match_status::text AS status, COUNT(*)::text AS c
     FROM import_voter_matches mr
     INNER JOIN import_rows ir ON ir.id = mr.import_row_id
     WHERE mr.import_batch_id = $1
     GROUP BY ir.chunk_number, mr.match_status
     ORDER BY ir.chunk_number, mr.match_status`,
    [batchId]
  );
  const out: Record<string, Record<string, number>> = {};
  for (const row of r.rows) {
    if (!out[row.chunk]) out[row.chunk] = {};
    out[row.chunk]![row.status] = Number.parseInt(row.c, 10);
  }
  return out;
}

/**
 * Adds review/audit counters to summary JSON when migration 002 columns exist.
 * No-op if review_status column is missing (older DBs).
 */
export async function tryAppendReviewStatsToSummary(
  pool: Pool,
  batchId: string,
  summary: SummaryReportJson
): Promise<void> {
  const col = await pool.query<{ e: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'import_voter_matches' AND column_name = 'review_status'
     ) AS e`
  );
  if (!col.rows[0]?.e) return;

  try {
    const mr = await pool.query<{
      review_queue_count: string;
      approved_count: string;
      rejected_count: string;
      needs_more_info_count: string;
    }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE match_status IN ('MULTIPLE_MATCHES', 'WEAK_MATCH', 'NOT_FOUND', 'ERROR')
             AND review_status IN ('UNREVIEWED', 'NEEDS_MORE_INFO')
         )::text AS review_queue_count,
         COUNT(*) FILTER (WHERE review_status = 'APPROVED')::text AS approved_count,
         COUNT(*) FILTER (WHERE review_status = 'REJECTED')::text AS rejected_count,
         COUNT(*) FILTER (WHERE review_status = 'NEEDS_MORE_INFO')::text AS needs_more_info_count
       FROM import_voter_matches
       WHERE import_batch_id = $1::uuid`,
      [batchId]
    );
    const row = mr.rows[0];
    if (row) {
      summary.review_queue_count = Number.parseInt(row.review_queue_count, 10);
      summary.approved_count = Number.parseInt(row.approved_count, 10);
      summary.rejected_count = Number.parseInt(row.rejected_count, 10);
      summary.needs_more_info_count = Number.parseInt(row.needs_more_info_count, 10);
    }

    const att = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM import_match_reviews
       WHERE import_batch_id = $1::uuid AND action = 'ATTACH_SIGNATURE'`,
      [batchId]
    );
    summary.manually_attached_count = Number.parseInt(att.rows[0]?.c ?? "0", 10);
  } catch {
    /* Missing import_match_reviews etc.: leave summary without review fields */
  }
}

export async function countMatchStatuses(
  pool: Pool,
  batchId: string
): Promise<{
  matched: number;
  notFound: number;
  multiple: number;
  weak: number;
  errors: number;
}> {
  const r = await pool.query<{ status: string; c: string }>(
    `SELECT match_status::text AS status, COUNT(*)::text AS c
     FROM import_voter_matches
     WHERE import_batch_id = $1
     GROUP BY match_status`,
    [batchId]
  );
  const m: Record<string, number> = {};
  for (const row of r.rows) {
    m[row.status] = Number.parseInt(row.c, 10);
  }
  return {
    matched: m.MATCHED ?? 0,
    notFound: m.NOT_FOUND ?? 0,
    multiple: m.MULTIPLE_MATCHES ?? 0,
    weak: m.WEAK_MATCH ?? 0,
    errors: m.ERROR ?? 0,
  };
}
