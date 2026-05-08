import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { MatchStatus, NormalizedRowJson } from "./types.js";
import { escapeCsvCell } from "./reports.js";
import {
  isSlamDunkMatch,
  parseQaFlagsJson,
  problemTagsForRow,
  recommendedActionForProblem,
  rowNeedsReviewByOutcome,
} from "./matchQuality.js";
import { writeReportWorkbook } from "./reportWorkbook.js";
import { buildConfidenceReason, calculateMatchConfidencePct, searchPriorityFromConfidence } from "./confidence.js";

async function pgViewExists(pool: Pool, viewName: string): Promise<boolean> {
  const r = await pool.query<{ e: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.views
       WHERE table_schema = 'public' AND table_name = $1
     ) AS e`,
    [viewName]
  );
  return Boolean(r.rows[0]?.e);
}

export type BatchSignatureReportRow = {
  import_batch_id: string;
  petition_code: string | null;
  petition_id: string | null;
  petition_name: string | null;
  import_row_id: string;
  import_voter_match_id: string;
  row_number: number;
  chunk_number: number;
  match_status: string;
  review_status: string;
  voter_id: string | null;
  resolved_voter_id: string | null;
  candidate_count: string;
  candidate_voter_ids: unknown;
  match_method: string | null;
  match_confidence: string | null;
  match_confidence_pct?: number | string | null;
  signature_match_confidence_pct?: number | string | null;
  raw_json: Record<string, unknown>;
  normalized_json: NormalizedRowJson;
  qa_flags: unknown;
  signer_first_name: string | null;
  signer_last_name: string | null;
  signer_full_name: string | null;
  signer_address: string | null;
  signer_city: string | null;
  signer_county: string | null;
  signer_state: string | null;
  signer_zip: string | null;
  signed_at: string | null;
  birth_month: string | null;
  birth_day: string | null;
  birth_year: string | null;
  birth_date: string | null;
  notes: string | null;
  source_file_name: string;
  batch_created_at: string | null;
  voter_petition_signature_id: string | null;
  signature_match_method: string | null;
  signature_voter_ward: string | null;
  signature_voter_precinct: string | null;
  signature_voter_district: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  resolution_note: string | null;
};

export async function loadBatchSignatureReportRows(pool: Pool, batchId: string): Promise<BatchSignatureReportRow[]> {
  const hasView = await pgViewExists(pool, "batch_signature_report_rows");
  if (!hasView) {
    throw new Error(
      "Database view batch_signature_report_rows is missing. Apply tools/voter-file-matcher/migrations/005_reporting_review_views.sql."
    );
  }
  const r = await pool.query<BatchSignatureReportRow>(
    `SELECT * FROM batch_signature_report_rows WHERE import_batch_id = $1::uuid ORDER BY row_number ASC`,
    [batchId]
  );
  return r.rows;
}

export type BatchReportSummaryJson = {
  batch_id: string;
  petition_code: string | null;
  petition_name: string | null;
  source_file_name: string | null;
  total_rows: number;
  total_signatures: number;
  matched_total: number;
  slam_dunk_matched: number;
  needs_review_total: number;
  not_found_total: number;
  multiple_matches_total: number;
  weak_matches_total: number;
  error_total: number;
  manually_approved_total: number;
  rejected_total: number;
  needs_more_info_total: number;
  match_rate: number;
  slam_dunk_rate: number;
  review_rate: number;
  ward_counts: Record<string, number>;
  problem_counts: Record<string, number>;
  top_problems: { problem: string; count: number }[];
  qa_counts: Record<string, number>;
  city_counts: Record<string, number>;
  zip_counts: Record<string, number>;
  date_signed_min: string | null;
  date_signed_max: string | null;
  warnings: string[];
  generated_at: string;
  initiative_scope?: string | null;
  reporting_geo?: string | null;
  avg_match_confidence_pct?: number | null;
  slam_dunk_100_count?: number;
  confidence_90_99_count?: number;
  confidence_75_89_count?: number;
  confidence_50_74_count?: number;
  confidence_1_49_count?: number;
  confidence_0_count?: number;
  confidence_distribution?: Record<string, number>;
};

function asFiniteNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function effectiveMatchPct(row: BatchSignatureReportRow): number | null {
  const sig = asFiniteNumber(row.signature_match_confidence_pct);
  if (sig != null) return sig;
  return asFiniteNumber(row.match_confidence_pct);
}

function slamFieldsFromRow(row: BatchSignatureReportRow) {
  return {
    match_status: row.match_status,
    candidate_count: row.candidate_count,
    voter_id: row.voter_id,
    match_method: row.match_method,
    match_confidence: row.match_confidence,
    match_confidence_pct: row.match_confidence_pct,
    qa_flags: row.qa_flags,
  };
}

function rowConfidencePctForDisplay(row: BatchSignatureReportRow): number {
  const direct = effectiveMatchPct(row);
  if (direct != null) return Math.round(direct);
  return calculateMatchConfidencePct({
    status: row.match_status as MatchStatus,
    matchMethod: row.match_method,
    matchConfidence: row.match_confidence != null ? Number.parseFloat(String(row.match_confidence)) : null,
    candidateCount: Number.parseInt(String(row.candidate_count ?? "0"), 10) || 0,
    voterId: row.voter_id,
    normalized: row.normalized_json,
  });
}

function confidenceBucketLabel(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "unknown";
  if (pct >= 100) return "100";
  if (pct >= 90) return "90_99";
  if (pct >= 75) return "75_89";
  if (pct >= 50) return "50_74";
  if (pct >= 1) return "1_49";
  return "0";
}

function aggregateProblemConfidenceBuckets(rows: BatchSignatureReportRow[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const tags = problemTagsForRow({
      ...slamFieldsFromRow(row),
      normalized: row.normalized_json,
      notes: row.notes,
      signature_voter_ward: row.signature_voter_ward,
    });
    const b = confidenceBucketLabel(effectiveMatchPct(row));
    for (const p of tags) {
      if (!out[p]) out[p] = {};
      out[p][b] = (out[p][b] ?? 0) + 1;
    }
  }
  return out;
}

function suggestedSearches(n: NormalizedRowJson): { s1: string; s2: string; s3: string } {
  const ln = (n.last_name ?? "").trim();
  const fn = (n.first_name ?? "").trim();
  const zip = (n.zip ?? "").trim();
  const city = (n.city ?? "").trim();
  const addr = (n.address_line_display ?? n.address ?? "").trim();
  const num = addr.match(/^\s*(\d+)/)?.[1] ?? "";
  return {
    s1: ln && zip ? `${ln} + ZIP ${zip}` : "",
    s2: ln && num ? `${ln} + street number ${num}` : "",
    s3: fn && ln && city ? `${fn} ${ln} + ${city}` : "",
  };
}

function csvLine(cells: (string | number | boolean | null | undefined)[]): string {
  return cells.map((c) => escapeCsvCell(c == null ? "" : typeof c === "boolean" ? c : String(c))).join(",");
}

function aggregateProblems(rows: BatchSignatureReportRow[]): {
  problem_counts: Record<string, number>;
  problem_examples: Record<string, number[]>;
} {
  const problem_counts: Record<string, number> = {};
  const problem_examples: Record<string, number[]> = {};
  for (const row of rows) {
    const tags = problemTagsForRow({
      ...slamFieldsFromRow(row),
      normalized: row.normalized_json,
      notes: row.notes,
      signature_voter_ward: row.signature_voter_ward,
    });
    for (const p of tags) {
      problem_counts[p] = (problem_counts[p] ?? 0) + 1;
      if (!problem_examples[p]) problem_examples[p] = [];
      const ex = problem_examples[p]!;
      if (ex.length < 10 && !ex.includes(row.row_number)) ex.push(row.row_number);
    }
  }
  return { problem_counts, problem_examples };
}

export type GeoRollupAgg = {
  total_matched: number;
  slam_dunk: number;
  manually_approved: number;
  needs_review_matched: number;
  sum_pct: number;
  n_pct: number;
  slam_dunk_100_count: number;
};

function wardBreakdown(rows: BatchSignatureReportRow[]) {
  const byWard: Record<string, GeoRollupAgg> = {};
  const bump = (ward: string) => {
    if (!byWard[ward]) {
      byWard[ward] = {
        total_matched: 0,
        slam_dunk: 0,
        manually_approved: 0,
        needs_review_matched: 0,
        sum_pct: 0,
        n_pct: 0,
        slam_dunk_100_count: 0,
      };
    }
    return byWard[ward]!;
  };
  let globalMatched = 0;
  for (const row of rows) {
    const slam = isSlamDunkMatch(slamFieldsFromRow(row));
    const ward = (row.signature_voter_ward ?? "").trim() || "UNKNOWN";
    if (row.voter_petition_signature_id) {
      globalMatched += 1;
      const w = bump(ward);
      w.total_matched += 1;
      const pct = effectiveMatchPct(row);
      if (pct != null) {
        w.sum_pct += pct;
        w.n_pct += 1;
      }
      if (row.signature_match_method === "MANUAL_REVIEW_APPROVE") w.manually_approved += 1;
      else if (slam && row.match_status === "MATCHED") w.slam_dunk += 1;
      else w.needs_review_matched += 1;
      if (
        row.signature_match_method !== "MANUAL_REVIEW_APPROVE" &&
        pct != null &&
        pct >= 100
      ) {
        w.slam_dunk_100_count += 1;
      }
    } else if (row.match_status === "MATCHED" && !slam) {
      const w = bump("UNKNOWN");
      w.needs_review_matched += 1;
    }
  }
  return { byWard, globalMatched };
}

function countyBreakdown(rows: BatchSignatureReportRow[]) {
  const byCounty: Record<string, GeoRollupAgg> = {};
  const bump = (county: string) => {
    if (!byCounty[county]) {
      byCounty[county] = {
        total_matched: 0,
        slam_dunk: 0,
        manually_approved: 0,
        needs_review_matched: 0,
        sum_pct: 0,
        n_pct: 0,
        slam_dunk_100_count: 0,
      };
    }
    return byCounty[county]!;
  };
  let globalMatched = 0;
  for (const row of rows) {
    const slam = isSlamDunkMatch(slamFieldsFromRow(row));
    const county = (row.signer_county ?? "").trim() || "UNKNOWN";
    if (row.voter_petition_signature_id) {
      globalMatched += 1;
      const c = bump(county);
      c.total_matched += 1;
      const pct = effectiveMatchPct(row);
      if (pct != null) {
        c.sum_pct += pct;
        c.n_pct += 1;
      }
      if (row.signature_match_method === "MANUAL_REVIEW_APPROVE") c.manually_approved += 1;
      else if (slam && row.match_status === "MATCHED") c.slam_dunk += 1;
      else c.needs_review_matched += 1;
      if (
        row.signature_match_method !== "MANUAL_REVIEW_APPROVE" &&
        pct != null &&
        pct >= 100
      ) {
        c.slam_dunk_100_count += 1;
      }
    } else if (row.match_status === "MATCHED" && !slam) {
      const c = bump("UNKNOWN");
      c.needs_review_matched += 1;
    }
  }
  return { byCounty, globalMatched };
}

export async function writeBatchOperatorReport(
  pool: Pool,
  opts: {
    batchId: string;
    outDir: string;
    json?: boolean;
    includeSensitiveConsole?: boolean;
  }
): Promise<{ summary: BatchReportSummaryJson; outDir: string }> {
  const rows = await loadBatchSignatureReportRows(pool, opts.batchId);
  if (rows.length === 0) {
    throw new Error(`No import rows for batch_id=${opts.batchId}`);
  }
  const first = rows[0]!;
  const total_rows = rows.length;
  const warnings: string[] = [];
  const hasGeoCol = rows.some((r) => (r.signature_voter_ward ?? "").trim().length > 0);
  if (!hasGeoCol && rows.some((r) => r.match_status === "MATCHED" && r.voter_petition_signature_id)) {
    warnings.push("Ward reporting requires ward or district fields on VFM_MATCH_SOURCE_TABLE (stored voter_ward is empty).");
  }

  let initiative_scope: string | null = null;
  let reporting_geo: string | null = null;
  if (first.petition_code) {
    try {
      const pr = await pool.query<{ initiative_scope: string | null; reporting_geo: string | null }>(
        `SELECT initiative_scope, reporting_geo FROM public.petitions WHERE petition_code = $1 LIMIT 1`,
        [first.petition_code]
      );
      initiative_scope = pr.rows[0]?.initiative_scope ?? null;
      reporting_geo = pr.rows[0]?.reporting_geo ?? null;
      const geoU = (reporting_geo ?? "").toUpperCase();
      const scopeU = (initiative_scope ?? "").toUpperCase();
      if ((geoU === "COUNTY" || scopeU === "STATEWIDE") && rows.some((r) => r.voter_petition_signature_id)) {
        const hasCountySigner = rows.some((r) => (r.signer_county ?? "").trim().length > 0);
        if (!hasCountySigner) {
          warnings.push(
            "County-centric reporting is configured but signer_county is empty on rows; matched_by_county will use UNKNOWN until county is populated on import."
          );
        }
      }
    } catch {
      /* Older DB without initiative columns */
    }
  }

  let matched_total = 0;
  let slam_dunk_matched = 0;
  let needs_review_total = 0;
  let not_found_total = 0;
  let multiple_matches_total = 0;
  let weak_matches_total = 0;
  let error_total = 0;
  let manually_approved_total = 0;
  let rejected_total = 0;
  let needs_more_info_total = 0;

  const city_counts: Record<string, number> = {};
  const zip_counts: Record<string, number> = {};
  const qa_counts: Record<string, number> = {};
  const signedDates: string[] = [];

  for (const row of rows) {
    if (row.match_status === "MATCHED") matched_total += 1;
    if (row.match_status === "NOT_FOUND") not_found_total += 1;
    if (row.match_status === "MULTIPLE_MATCHES") multiple_matches_total += 1;
    if (row.match_status === "WEAK_MATCH") weak_matches_total += 1;
    if (row.match_status === "ERROR") error_total += 1;
    if (isSlamDunkMatch(slamFieldsFromRow(row))) slam_dunk_matched += 1;
    if (rowNeedsReviewByOutcome(slamFieldsFromRow(row))) needs_review_total += 1;
    if (row.signature_match_method === "MANUAL_REVIEW_APPROVE") manually_approved_total += 1;
    if (row.review_status === "REJECTED") rejected_total += 1;
    if (row.review_status === "NEEDS_MORE_INFO") needs_more_info_total += 1;

    const c = (row.signer_city ?? "").trim();
    if (c) city_counts[c] = (city_counts[c] ?? 0) + 1;
    const z = (row.signer_zip ?? "").trim();
    if (z) zip_counts[z] = (zip_counts[z] ?? 0) + 1;
    const sa = (row.signed_at ?? "").trim();
    if (sa) signedDates.push(sa);
    for (const f of parseQaFlagsJson(row.qa_flags)) {
      qa_counts[f] = (qa_counts[f] ?? 0) + 1;
    }
  }
  signedDates.sort();
  const date_signed_min = signedDates.length ? signedDates[0]! : null;
  const date_signed_max = signedDates.length ? signedDates[signedDates.length - 1]! : null;

  const { problem_counts, problem_examples } = aggregateProblems(rows);
  const problemBuckets = aggregateProblemConfidenceBuckets(rows);
  const top_problems = Object.entries(problem_counts)
    .map(([problem, count]) => ({ problem, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const { byWard, globalMatched } = wardBreakdown(rows);
  const { byCounty } = countyBreakdown(rows);
  const ward_counts: Record<string, number> = {};
  for (const [w, v] of Object.entries(byWard)) {
    ward_counts[w] = v.total_matched;
  }

  const pctVals: number[] = [];
  const confidence_distribution: Record<string, number> = {};
  for (const row of rows) {
    const p = rowConfidencePctForDisplay(row);
    pctVals.push(p);
    const b = confidenceBucketLabel(p);
    confidence_distribution[b] = (confidence_distribution[b] ?? 0) + 1;
  }
  const avg_match_confidence_pct =
    pctVals.length > 0 ? Math.round((pctVals.reduce((a, x) => a + x, 0) / pctVals.length) * 10) / 10 : null;
  const slam_dunk_100_count = rows.filter(
    (r) =>
      r.voter_petition_signature_id &&
      r.signature_match_method !== "MANUAL_REVIEW_APPROVE" &&
      (effectiveMatchPct(r) ?? 0) >= 100
  ).length;

  const total_signatures = rows.filter((r) => r.voter_petition_signature_id).length;
  const match_rate = total_rows ? matched_total / total_rows : 0;
  const slam_dunk_rate = total_rows ? slam_dunk_matched / total_rows : 0;
  const review_rate = total_rows ? needs_review_total / total_rows : 0;

  const summary: BatchReportSummaryJson = {
    batch_id: opts.batchId,
    petition_code: first.petition_code,
    petition_name: first.petition_name,
    source_file_name: first.source_file_name,
    total_rows,
    total_signatures,
    matched_total,
    slam_dunk_matched,
    needs_review_total,
    not_found_total,
    multiple_matches_total,
    weak_matches_total,
    error_total,
    manually_approved_total,
    rejected_total,
    needs_more_info_total,
    match_rate,
    slam_dunk_rate,
    review_rate,
    ward_counts,
    problem_counts,
    top_problems,
    qa_counts,
    city_counts,
    zip_counts,
    date_signed_min,
    date_signed_max,
    warnings,
    generated_at: new Date().toISOString(),
    initiative_scope,
    reporting_geo,
    avg_match_confidence_pct,
    slam_dunk_100_count,
    confidence_90_99_count: confidence_distribution["90_99"] ?? 0,
    confidence_75_89_count: confidence_distribution["75_89"] ?? 0,
    confidence_50_74_count: confidence_distribution["50_74"] ?? 0,
    confidence_1_49_count: confidence_distribution["1_49"] ?? 0,
    confidence_0_count: confidence_distribution["0"] ?? 0,
    confidence_distribution,
  };

  await mkdir(opts.outDir, { recursive: true });
  await writeFile(join(opts.outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  const slamRows = rows.filter((r) => isSlamDunkMatch(slamFieldsFromRow(r)));
  const slamCsv = [
    "row_number,voter_id,first_name,last_name,city,zip,ward,precinct,match_method,match_confidence,match_confidence_pct,signed_at",
    ...slamRows.map((r) =>
      csvLine([
        r.row_number,
        r.voter_id ?? "",
        r.signer_first_name ?? "",
        r.signer_last_name ?? "",
        r.signer_city ?? "",
        r.signer_zip ?? "",
        r.signature_voter_ward ?? "",
        r.signature_voter_precinct ?? "",
        r.match_method ?? "",
        r.match_confidence ?? "",
        rowConfidencePctForDisplay(r),
        r.signed_at ?? "",
      ])
    ),
  ].join("\n");
  await writeFile(join(opts.outDir, "matched_slam_dunk.csv"), slamCsv + "\n", "utf8");

  const matchedNeed = rows.filter((r) => r.match_status === "MATCHED" && !isSlamDunkMatch(slamFieldsFromRow(r)));
  const mnrHeader =
    "row_number,voter_id,first_name,last_name,city,zip,ward,precinct,match_method,match_confidence,match_confidence_pct,signed_at,review_status";
  await writeFile(
    join(opts.outDir, "matched_needs_review.csv"),
    [
      mnrHeader,
      ...matchedNeed.map((r) =>
        csvLine([
          r.row_number,
          r.voter_id ?? "",
          r.signer_first_name ?? "",
          r.signer_last_name ?? "",
          r.signer_city ?? "",
          r.signer_zip ?? "",
          r.signature_voter_ward ?? "",
          r.signature_voter_precinct ?? "",
          r.match_method ?? "",
          r.match_confidence ?? "",
          rowConfidencePctForDisplay(r),
          r.signed_at ?? "",
          r.review_status,
        ])
      ),
    ].join("\n") + "\n",
    "utf8"
  );

  const reviewCsvRows = rows.filter(
    (r) =>
      r.match_status !== "MATCHED" ||
      (r.match_status === "MATCHED" && !isSlamDunkMatch(slamFieldsFromRow(r)))
  );
  const reviewHeader =
    "row_number,review_status,match_status,problem_summary,first_name,last_name,full_name,birth_month,birth_day,birth_year,birth_date,address,city,state,zip,signed_at,notes,qa_flags,candidate_count,candidate_voter_ids,match_method,match_confidence,match_confidence_pct,confidence_reason,search_priority,suggested_search_1,suggested_search_2,suggested_search_3,reviewer_decision,reviewer_selected_voter_id,reviewer_notes";
  const doNotMatchBody =
    [
      reviewHeader,
      ...reviewCsvRows.map((r) => {
        const n = r.normalized_json;
        const prob = problemTagsForRow({
          ...slamFieldsFromRow(r),
          normalized: n,
          notes: r.notes,
          signature_voter_ward: r.signature_voter_ward,
        }).join("; ");
        const sug = suggestedSearches(n);
        const pct = rowConfidencePctForDisplay(r);
        const confIn = {
          status: r.match_status as MatchStatus,
          matchMethod: r.match_method,
          matchConfidence: r.match_confidence != null ? Number.parseFloat(String(r.match_confidence)) : null,
          candidateCount: Number.parseInt(String(r.candidate_count ?? "0"), 10) || 0,
          voterId: r.voter_id,
          normalized: n,
        };
        const reason = buildConfidenceReason(confIn, pct);
        const sp = searchPriorityFromConfidence(pct, r.match_status, n);
        return csvLine([
          r.row_number,
          r.review_status,
          r.match_status,
          prob,
          r.signer_first_name ?? "",
          r.signer_last_name ?? "",
          r.signer_full_name ?? "",
          r.birth_month ?? "",
          r.birth_day ?? "",
          r.birth_year ?? "",
          r.birth_date ?? "",
          r.signer_address ?? "",
          r.signer_city ?? "",
          r.signer_state ?? "",
          r.signer_zip ?? "",
          r.signed_at ?? "",
          r.notes ?? "",
          parseQaFlagsJson(r.qa_flags).join("|"),
          r.candidate_count,
          JSON.stringify(r.candidate_voter_ids ?? []),
          r.match_method ?? "",
          r.match_confidence ?? "",
          pct,
          reason,
          sp,
          sug.s1,
          sug.s2,
          sug.s3,
          r.review_status,
          r.resolved_voter_id ?? "",
          r.resolution_note ?? "",
        ]);
      }),
    ].join("\n") + "\n";
  await writeFile(join(opts.outDir, "do_not_match_review.csv"), doNotMatchBody, "utf8");
  await writeFile(join(opts.outDir, "review_queue.csv"), doNotMatchBody, "utf8");

  const wardHeader =
    "ward,total_matched,slam_dunk,manually_approved,needs_review_matched,avg_confidence_pct,slam_dunk_100_count,needs_review_count,percent_of_matched";
  const wardLines = [wardHeader];
  for (const [ward, v] of Object.entries(byWard)) {
    const pct = globalMatched > 0 ? (v.total_matched / globalMatched) * 100 : 0;
    const avgPct = v.n_pct > 0 ? (v.sum_pct / v.n_pct).toFixed(1) : "";
    wardLines.push(
      csvLine([
        ward,
        v.total_matched,
        v.slam_dunk,
        v.manually_approved,
        v.needs_review_matched,
        avgPct,
        v.slam_dunk_100_count,
        v.needs_review_matched,
        pct.toFixed(2),
      ])
    );
  }
  await writeFile(join(opts.outDir, "matched_by_ward.csv"), wardLines.join("\n") + "\n", "utf8");

  const countyHeader =
    "county,total_matched,slam_dunk_100,manually_approved,needs_review_matched,avg_confidence_pct,percent_of_matched";
  const countyLines = [countyHeader];
  const countyGlobal = Object.values(byCounty).reduce((s, v) => s + v.total_matched, 0);
  for (const [county, v] of Object.entries(byCounty)) {
    const pct = countyGlobal > 0 ? (v.total_matched / countyGlobal) * 100 : 0;
    const avgPct = v.n_pct > 0 ? (v.sum_pct / v.n_pct).toFixed(1) : "";
    countyLines.push(
      csvLine([
        county,
        v.total_matched,
        v.slam_dunk_100_count,
        v.manually_approved,
        v.needs_review_matched,
        avgPct,
        pct.toFixed(2),
      ])
    );
  }
  await writeFile(join(opts.outDir, "matched_by_county.csv"), countyLines.join("\n") + "\n", "utf8");

  const probLines = [
    "problem,count,percent_of_total,example_row_numbers,recommended_action,bucket_100,bucket_90_99,bucket_75_89,bucket_50_74,bucket_1_49,bucket_0,bucket_unknown",
    ...Object.entries(problem_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([problem, count]) => {
        const pct = total_rows ? (count / total_rows) * 100 : 0;
        const ex = (problem_examples[problem] ?? []).join("|");
        const bk = problemBuckets[problem] ?? {};
        return csvLine([
          problem,
          count,
          pct.toFixed(2),
          ex,
          recommendedActionForProblem(problem),
          bk["100"] ?? 0,
          bk["90_99"] ?? 0,
          bk["75_89"] ?? 0,
          bk["50_74"] ?? 0,
          bk["1_49"] ?? 0,
          bk["0"] ?? 0,
          bk["unknown"] ?? 0,
        ]);
      }),
  ];
  await writeFile(join(opts.outDir, "biggest_problems.csv"), probLines.join("\n") + "\n", "utf8");

  const qaHeader =
    "row_number,qa_flags,first_name_present,last_name_present,address_present,city,state,zip,signed_at,notes_present,match_status,review_status,voter_id";
  const qaLines = [qaHeader];
  for (const r of rows) {
    const n = r.normalized_json;
    const flags = parseQaFlagsJson(r.qa_flags);
    qaLines.push(
      csvLine([
        r.row_number,
        flags.join("|"),
        Boolean(n.first_name),
        Boolean(n.last_name),
        Boolean(n.address || n.address_line_display),
        n.city ?? "",
        n.state ?? "",
        n.zip ?? "",
        n.signed_at ?? "",
        Boolean(n.notes),
        r.match_status,
        r.review_status,
        r.voter_id ?? "",
      ])
    );
  }
  await writeFile(join(opts.outDir, "qa_flags.csv"), qaLines.join("\n") + "\n", "utf8");

  await writeReportWorkbook(join(opts.outDir, "report_workbook.xlsx"), {
    summary,
    slamRows,
    reviewCsvRows,
    wardRows: Object.entries(byWard).map(([ward, v]) => ({
      ward,
      total_matched: v.total_matched,
      slam_dunk: v.slam_dunk,
      manually_approved: v.manually_approved,
      needs_review_matched: v.needs_review_matched,
      avg_confidence_pct: v.n_pct > 0 ? (v.sum_pct / v.n_pct).toFixed(1) : "",
      slam_dunk_100_count: v.slam_dunk_100_count,
      needs_review_count: v.needs_review_matched,
      percent_of_matched: globalMatched > 0 ? ((v.total_matched / globalMatched) * 100).toFixed(2) : "0",
    })),
    countyRows: Object.entries(byCounty).map(([county, v]) => ({
      county,
      total_matched: v.total_matched,
      slam_dunk_100: v.slam_dunk_100_count,
      manually_approved: v.manually_approved,
      needs_review_matched: v.needs_review_matched,
      avg_confidence_pct: v.n_pct > 0 ? (v.sum_pct / v.n_pct).toFixed(1) : "",
      percent_of_matched:
        countyGlobal > 0 ? ((v.total_matched / countyGlobal) * 100).toFixed(2) : "0",
    })),
    problemRows: Object.entries(problem_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([problem, count]) => {
        const bk = problemBuckets[problem] ?? {};
        return {
          problem,
          count,
          percent_of_total: total_rows ? ((count / total_rows) * 100).toFixed(2) : "0",
          example_row_numbers: (problem_examples[problem] ?? []).join("|"),
          recommended_action: recommendedActionForProblem(problem),
          bucket_100: bk["100"] ?? 0,
          bucket_90_99: bk["90_99"] ?? 0,
          bucket_75_89: bk["75_89"] ?? 0,
          bucket_50_74: bk["50_74"] ?? 0,
          bucket_1_49: bk["1_49"] ?? 0,
          bucket_0: bk["0"] ?? 0,
          bucket_unknown: bk["unknown"] ?? 0,
        };
      }),
    confidenceDistribution: Object.entries(confidence_distribution).map(([bucket, count]) => ({
      bucket,
      count,
    })),
    qaRows: rows.map((r) => {
      const n = r.normalized_json;
      const flags = parseQaFlagsJson(r.qa_flags);
      return {
        row_number: r.row_number,
        qa_flags: flags.join("|"),
        first_name_present: Boolean(n.first_name),
        last_name_present: Boolean(n.last_name),
        address_present: Boolean(n.address || n.address_line_display),
        city: n.city ?? "",
        state: n.state ?? "",
        zip: n.zip ?? "",
        signed_at: n.signed_at ?? "",
        notes_present: Boolean(n.notes),
        match_status: r.match_status,
        review_status: r.review_status,
        voter_id: r.voter_id ?? "",
        match_confidence_pct: rowConfidencePctForDisplay(r),
      };
    }),
  });

  return { summary, outDir: opts.outDir };
}

export async function loadPetitionReportRows(pool: Pool, petitionCode: string): Promise<BatchSignatureReportRow[]> {
  const hasView = await pgViewExists(pool, "batch_signature_report_rows");
  if (!hasView) {
    throw new Error(
      "Database view batch_signature_report_rows is missing. Apply tools/voter-file-matcher/migrations/005_reporting_review_views.sql."
    );
  }
  const r = await pool.query<BatchSignatureReportRow>(
    `SELECT bsr.*
     FROM batch_signature_report_rows bsr
     INNER JOIN import_batches b ON b.id = bsr.import_batch_id
     WHERE b.petition_code = $1
     ORDER BY b.created_at ASC, bsr.row_number ASC`,
    [petitionCode]
  );
  return r.rows;
}

export type PetitionReportSummaryJson = BatchReportSummaryJson & {
  petition_code: string;
  batch_ids: string[];
};

export async function writePetitionOperatorReport(
  pool: Pool,
  opts: { petitionCode: string; outDir: string }
): Promise<{ summary: PetitionReportSummaryJson; outDir: string }> {
  const rows = await loadPetitionReportRows(pool, opts.petitionCode);
  if (rows.length === 0) {
    throw new Error(`No rows for petition_code=${opts.petitionCode}`);
  }
  const batchIds = [...new Set(rows.map((r) => r.import_batch_id))];
  const first = rows[0]!;

  const warnings: string[] = [];
  const total_rows = rows.length;
  let matched_total = 0;
  let slam_dunk_matched = 0;
  let needs_review_total = 0;
  let not_found_total = 0;
  let multiple_matches_total = 0;
  let weak_matches_total = 0;
  let error_total = 0;
  let manually_approved_total = 0;
  let rejected_total = 0;
  let needs_more_info_total = 0;
  const city_counts: Record<string, number> = {};
  const zip_counts: Record<string, number> = {};
  const qa_counts: Record<string, number> = {};
  const signedDates: string[] = [];
  for (const row of rows) {
    if (row.match_status === "MATCHED") matched_total += 1;
    if (row.match_status === "NOT_FOUND") not_found_total += 1;
    if (row.match_status === "MULTIPLE_MATCHES") multiple_matches_total += 1;
    if (row.match_status === "WEAK_MATCH") weak_matches_total += 1;
    if (row.match_status === "ERROR") error_total += 1;
    if (isSlamDunkMatch(slamFieldsFromRow(row))) slam_dunk_matched += 1;
    if (rowNeedsReviewByOutcome(slamFieldsFromRow(row))) needs_review_total += 1;
    if (row.signature_match_method === "MANUAL_REVIEW_APPROVE") manually_approved_total += 1;
    if (row.review_status === "REJECTED") rejected_total += 1;
    if (row.review_status === "NEEDS_MORE_INFO") needs_more_info_total += 1;
    const c = (row.signer_city ?? "").trim();
    if (c) city_counts[c] = (city_counts[c] ?? 0) + 1;
    const z = (row.signer_zip ?? "").trim();
    if (z) zip_counts[z] = (zip_counts[z] ?? 0) + 1;
    const sa = (row.signed_at ?? "").trim();
    if (sa) signedDates.push(sa);
    for (const f of parseQaFlagsJson(row.qa_flags)) {
      qa_counts[f] = (qa_counts[f] ?? 0) + 1;
    }
  }
  signedDates.sort();
  const { problem_counts, problem_examples } = aggregateProblems(rows);
  const problemBuckets = aggregateProblemConfidenceBuckets(rows);
  const top_problems = Object.entries(problem_counts)
    .map(([problem, count]) => ({ problem, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
  const { byWard, globalMatched } = wardBreakdown(rows);
  const { byCounty } = countyBreakdown(rows);
  const ward_counts: Record<string, number> = {};
  for (const [w, v] of Object.entries(byWard)) {
    ward_counts[w] = v.total_matched;
  }

  const pctVals: number[] = [];
  const confidence_distribution: Record<string, number> = {};
  for (const row of rows) {
    const p = rowConfidencePctForDisplay(row);
    pctVals.push(p);
    const b = confidenceBucketLabel(p);
    confidence_distribution[b] = (confidence_distribution[b] ?? 0) + 1;
  }
  const avg_match_confidence_pct =
    pctVals.length > 0 ? Math.round((pctVals.reduce((a, x) => a + x, 0) / pctVals.length) * 10) / 10 : null;
  const slam_dunk_100_count = rows.filter(
    (r) =>
      r.voter_petition_signature_id &&
      r.signature_match_method !== "MANUAL_REVIEW_APPROVE" &&
      (effectiveMatchPct(r) ?? 0) >= 100
  ).length;

  let initiative_scope: string | null = null;
  let reporting_geo: string | null = null;
  try {
    const pr = await pool.query<{ initiative_scope: string | null; reporting_geo: string | null }>(
      `SELECT initiative_scope, reporting_geo FROM public.petitions WHERE petition_code = $1 LIMIT 1`,
      [opts.petitionCode]
    );
    initiative_scope = pr.rows[0]?.initiative_scope ?? null;
    reporting_geo = pr.rows[0]?.reporting_geo ?? null;
  } catch {
    /* optional */
  }

  const total_signatures = rows.filter((r) => r.voter_petition_signature_id).length;
  const summary: PetitionReportSummaryJson = {
    batch_id: batchIds.join(","),
    batch_ids: batchIds,
    petition_code: opts.petitionCode,
    petition_name: first.petition_name,
    source_file_name: `${batchIds.length} batches`,
    total_rows,
    total_signatures,
    matched_total,
    slam_dunk_matched,
    needs_review_total,
    not_found_total,
    multiple_matches_total,
    weak_matches_total,
    error_total,
    manually_approved_total,
    rejected_total,
    needs_more_info_total,
    match_rate: total_rows ? matched_total / total_rows : 0,
    slam_dunk_rate: total_rows ? slam_dunk_matched / total_rows : 0,
    review_rate: total_rows ? needs_review_total / total_rows : 0,
    ward_counts,
    problem_counts,
    top_problems,
    qa_counts,
    city_counts,
    zip_counts,
    date_signed_min: signedDates.length ? signedDates[0]! : null,
    date_signed_max: signedDates.length ? signedDates[signedDates.length - 1]! : null,
    warnings,
    generated_at: new Date().toISOString(),
    initiative_scope,
    reporting_geo,
    avg_match_confidence_pct,
    slam_dunk_100_count,
    confidence_90_99_count: confidence_distribution["90_99"] ?? 0,
    confidence_75_89_count: confidence_distribution["75_89"] ?? 0,
    confidence_50_74_count: confidence_distribution["50_74"] ?? 0,
    confidence_1_49_count: confidence_distribution["1_49"] ?? 0,
    confidence_0_count: confidence_distribution["0"] ?? 0,
    confidence_distribution,
  };
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(join(opts.outDir, "petition_summary.json"), JSON.stringify(summary, null, 2), "utf8");

  const wardHeader =
    "ward,total_matched,slam_dunk,manually_approved,needs_review_matched,avg_confidence_pct,slam_dunk_100_count,needs_review_count,percent_of_matched";
  const wardLines = [wardHeader];
  for (const [ward, v] of Object.entries(byWard)) {
    const pct = globalMatched > 0 ? (v.total_matched / globalMatched) * 100 : 0;
    const avgPct = v.n_pct > 0 ? (v.sum_pct / v.n_pct).toFixed(1) : "";
    wardLines.push(
      csvLine([
        ward,
        v.total_matched,
        v.slam_dunk,
        v.manually_approved,
        v.needs_review_matched,
        avgPct,
        v.slam_dunk_100_count,
        v.needs_review_matched,
        pct.toFixed(2),
      ])
    );
  }
  await writeFile(join(opts.outDir, "petition_matched_by_ward.csv"), wardLines.join("\n") + "\n", "utf8");

  const countyHeader =
    "county,total_matched,slam_dunk_100,manually_approved,needs_review_matched,avg_confidence_pct,percent_of_matched";
  const countyLines = [countyHeader];
  const countyGlobal = Object.values(byCounty).reduce((s, v) => s + v.total_matched, 0);
  for (const [county, v] of Object.entries(byCounty)) {
    const pct = countyGlobal > 0 ? (v.total_matched / countyGlobal) * 100 : 0;
    const avgPct = v.n_pct > 0 ? (v.sum_pct / v.n_pct).toFixed(1) : "";
    countyLines.push(
      csvLine([
        county,
        v.total_matched,
        v.slam_dunk_100_count,
        v.manually_approved,
        v.needs_review_matched,
        avgPct,
        pct.toFixed(2),
      ])
    );
  }
  await writeFile(join(opts.outDir, "petition_matched_by_county.csv"), countyLines.join("\n") + "\n", "utf8");

  const sigHeader =
    "batch_id,row_number,match_status,review_status,voter_id,first_name,last_name,city,zip,signed_at,ward,match_confidence_pct";
  await writeFile(
    join(opts.outDir, "petition_all_signatures.csv"),
    [
      sigHeader,
      ...rows
        .filter((r) => r.voter_petition_signature_id)
        .map((r) =>
          csvLine([
            r.import_batch_id,
            r.row_number,
            r.match_status,
            r.review_status,
            r.voter_id ?? "",
            r.signer_first_name ?? "",
            r.signer_last_name ?? "",
            r.signer_city ?? "",
            r.signer_zip ?? "",
            r.signed_at ?? "",
            r.signature_voter_ward ?? "",
            rowConfidencePctForDisplay(r),
          ])
        ),
    ].join("\n") + "\n",
    "utf8"
  );

  const reviewCsvRows = rows.filter(
    (r) =>
      r.match_status !== "MATCHED" ||
      (r.match_status === "MATCHED" && !isSlamDunkMatch(slamFieldsFromRow(r)))
  );
  const reviewHeader =
    "batch_id,row_number,review_status,match_status,problem_summary,first_name,last_name,city,zip,signed_at,qa_flags";
  await writeFile(
    join(opts.outDir, "petition_review_remaining.csv"),
    [
      reviewHeader,
      ...reviewCsvRows.map((r) =>
        csvLine([
          r.import_batch_id,
          r.row_number,
          r.review_status,
          r.match_status,
          problemTagsForRow({
            ...slamFieldsFromRow(r),
            normalized: r.normalized_json,
            notes: r.notes,
            signature_voter_ward: r.signature_voter_ward,
          }).join("; "),
          r.signer_first_name ?? "",
          r.signer_last_name ?? "",
          r.signer_city ?? "",
          r.signer_zip ?? "",
          r.signed_at ?? "",
          parseQaFlagsJson(r.qa_flags).join("|"),
        ])
      ),
    ].join("\n") + "\n",
    "utf8"
  );

  const probLines = [
    "problem,count,percent_of_total,example_row_numbers,recommended_action,bucket_100,bucket_90_99,bucket_75_89,bucket_50_74,bucket_1_49,bucket_0,bucket_unknown",
    ...Object.entries(problem_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([problem, count]) => {
        const pct = total_rows ? (count / total_rows) * 100 : 0;
        const ex = (problem_examples[problem] ?? []).join("|");
        const bk = problemBuckets[problem] ?? {};
        return csvLine([
          problem,
          count,
          pct.toFixed(2),
          ex,
          recommendedActionForProblem(problem),
          bk["100"] ?? 0,
          bk["90_99"] ?? 0,
          bk["75_89"] ?? 0,
          bk["50_74"] ?? 0,
          bk["1_49"] ?? 0,
          bk["0"] ?? 0,
          bk["unknown"] ?? 0,
        ]);
      }),
  ];
  await writeFile(join(opts.outDir, "petition_biggest_problems.csv"), probLines.join("\n") + "\n", "utf8");

  await writeReportWorkbook(join(opts.outDir, "petition_report_workbook.xlsx"), {
    summary: summary as unknown as BatchReportSummaryJson,
    slamRows: rows.filter((r) => isSlamDunkMatch(slamFieldsFromRow(r))),
    reviewCsvRows,
    wardRows: Object.entries(byWard).map(([ward, v]) => ({
      ward,
      total_matched: v.total_matched,
      slam_dunk: v.slam_dunk,
      manually_approved: v.manually_approved,
      needs_review_matched: v.needs_review_matched,
      avg_confidence_pct: v.n_pct > 0 ? (v.sum_pct / v.n_pct).toFixed(1) : "",
      slam_dunk_100_count: v.slam_dunk_100_count,
      needs_review_count: v.needs_review_matched,
      percent_of_matched: globalMatched > 0 ? ((v.total_matched / globalMatched) * 100).toFixed(2) : "0",
    })),
    countyRows: Object.entries(byCounty).map(([county, v]) => ({
      county,
      total_matched: v.total_matched,
      slam_dunk_100: v.slam_dunk_100_count,
      manually_approved: v.manually_approved,
      needs_review_matched: v.needs_review_matched,
      avg_confidence_pct: v.n_pct > 0 ? (v.sum_pct / v.n_pct).toFixed(1) : "",
      percent_of_matched:
        countyGlobal > 0 ? ((v.total_matched / countyGlobal) * 100).toFixed(2) : "0",
    })),
    problemRows: Object.entries(problem_counts)
      .sort((a, b) => b[1] - a[1])
      .map(([problem, count]) => {
        const bk = problemBuckets[problem] ?? {};
        return {
          problem,
          count,
          percent_of_total: total_rows ? ((count / total_rows) * 100).toFixed(2) : "0",
          example_row_numbers: (problem_examples[problem] ?? []).join("|"),
          recommended_action: recommendedActionForProblem(problem),
          bucket_100: bk["100"] ?? 0,
          bucket_90_99: bk["90_99"] ?? 0,
          bucket_75_89: bk["75_89"] ?? 0,
          bucket_50_74: bk["50_74"] ?? 0,
          bucket_1_49: bk["1_49"] ?? 0,
          bucket_0: bk["0"] ?? 0,
          bucket_unknown: bk["unknown"] ?? 0,
        };
      }),
    confidenceDistribution: Object.entries(confidence_distribution).map(([bucket, count]) => ({
      bucket,
      count,
    })),
    qaRows: rows.map((r) => {
      const n = r.normalized_json;
      const flags = parseQaFlagsJson(r.qa_flags);
      return {
        row_number: r.row_number,
        qa_flags: flags.join("|"),
        first_name_present: Boolean(n.first_name),
        last_name_present: Boolean(n.last_name),
        address_present: Boolean(n.address || n.address_line_display),
        city: n.city ?? "",
        state: n.state ?? "",
        zip: n.zip ?? "",
        signed_at: n.signed_at ?? "",
        notes_present: Boolean(n.notes),
        match_status: r.match_status,
        review_status: r.review_status,
        voter_id: r.voter_id ?? "",
        match_confidence_pct: rowConfidencePctForDisplay(r),
      };
    }),
  });

  return { summary, outDir: opts.outDir };
}