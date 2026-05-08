#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { loadVfmEnv } from "./env-load.js";
loadVfmEnv();

import { createPool } from "./db.js";
import { buildCanonicalColumnMap } from "./matcher.js";
import { loadHeaderMapFile } from "./headerMap.js";
import { runPreflightOnSheet } from "./preflight.js";
import type { ParseFileOptions } from "./parseFile.js";
import { parseVoterBuffer } from "./parseFile.js";
import { runValidateConfig, runValidateDb } from "./validation.js";
import { discoverVoterSchema } from "./schemaDiscovery.js";
import { buildMatchSourcePlan } from "./matchSourcePlanner.js";
import {
  assertSafeMatchSourceViewSql,
  emitMatchSourceViewSql,
  loadMatchSourcePlan,
  readSqlFile,
} from "./sqlEmitter.js";
import {
  evaluateCandidateProbe,
  evaluateMatchReadiness,
  getMatchSourceMode,
  inspectVoterMatchSource,
  readMatchSourceTableEnv,
} from "./matchSource.js";
import {
  DEFAULT_REVIEW_QUEUE_STATUSES,
  exportReviewQueueCsv,
  fetchBatchSummary,
  fetchReviewQueue,
  parseCsvStatuses,
  runAddReviewNote,
  runApproveRow,
  runNeedsMoreInfo,
  runRejectRow,
  runReviewProgress,
} from "./review.js";
import { writeBatchOperatorReport, writePetitionOperatorReport } from "./reporting.js";
import { fetchNextReviewRow, searchVotersForRow } from "./reviewSearch.js";
import { processMappedRow } from "./rowPipeline.js";
import { runFullImport } from "./importRunner.js";
import {
  executeImportPlanFromDisk,
  importPlansTableExists,
  inspectImportPlanSummary,
  listImportPlansFromDb,
  prepareImportPlan,
  readImportPlan,
  reviewImportPlan,
  saveImportPlanToDb,
} from "./importPlan.js";
import {
  fetchInitiativeByCode,
  getInitiativeSummary,
  listInitiatives,
  upsertInitiative,
} from "./initiatives.js";
import { toTitleCaseFromLower } from "./normalize.js";
import type { NormalizedRowJson, ParsedSheet, RawRowJson, SummaryReportJson } from "./types.js";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function loadProjectKey(cli?: string): string {
  const v = (cli ?? process.env.VFM_PROJECT_KEY)?.trim();
  if (!v) throw new Error("project key: pass --project or set VFM_PROJECT_KEY");
  return v;
}

function loadCanonicalTable(): string {
  return requireEnv("VFM_CANONICAL_TABLE");
}

type ReviewCliOpts = {
  batchSummary?: string;
  reviewQueue?: boolean;
  exportReviewQueue?: boolean;
  approveRow?: boolean;
  rejectRow?: boolean;
  needsMoreInfo?: boolean;
  addReviewNote?: boolean;
  batchId?: string;
  status?: string;
  limit?: number;
  json?: boolean;
  out?: string;
  rowNumber?: number;
  voterId?: string;
  reviewedBy?: string;
  note?: string;
  reportBatch?: string;
  reportPetition?: string;
  nextReviewRow?: boolean;
  searchVotersForRow?: boolean;
  approveReviewCandidate?: boolean;
  skipReviewRow?: boolean;
  rejectReviewRow?: boolean;
  reviewProgress?: boolean;
  includeSensitive?: boolean;
  searchLastName?: string;
  searchFirstName?: string;
  searchCity?: string;
  searchZip?: string;
  searchAddress?: string;
  includeAddress?: boolean;
  omitAddressSearch?: boolean;
};

type Opts = {
  file?: string;
  project?: string;
  map?: string;
  profile?: string;
  petitionCode?: string;
  petitionName?: string;
  sourceLabel?: string;
  createdBy?: string;
  dryRun?: boolean;
  preflightFile?: boolean;
  chunkSize?: number;
  validateConfig?: boolean;
  validateDb?: boolean;
  inspectVoterSource?: boolean;
  matchReadiness?: boolean;
  candidateProbe?: boolean;
  discoverVoterSchema?: boolean;
  planMatchSource?: boolean;
  emitMatchSourceSql?: boolean;
  applyMatchSourceSql?: boolean;
  canonicalTable?: string;
  includeRelated?: boolean;
  plan?: string;
  target?: string;
  sql?: string;
  confirmApplyMatchSource?: boolean;
  prepareImportPlan?: boolean;
  reviewImportPlan?: boolean;
  executeImportPlan?: boolean;
  listImportPlans?: boolean;
  inspectImportPlan?: boolean;
  confirmDirectImport?: boolean;
  confirmExecuteImport?: boolean;
  savePlanDb?: boolean;
  allowReviewWithWarnings?: boolean;
  allowFileHashMismatch?: boolean;
  candidateProbeLimit?: number;
  /** Filter for --list-import-plans (operator_review_status). */
  importPlanStatus?: string;
  operatorNote?: string;
  upsertInitiative?: boolean;
  listInitiatives?: boolean;
  initiativeSummary?: string;
  initiativeScope?: string;
  reportingGeo?: string;
  targetSignatureCount?: number;
  initiativeNotes?: string;
  autoCreateInitiative?: boolean;
} & ReviewCliOpts;

function resolveMapOrProfilePath(opts: Opts): string {
  const hasProfile = Boolean(opts.profile?.trim());
  const hasMap = Boolean(opts.map?.trim());
  if (hasProfile && hasMap) {
    throw new Error("Pass either --map or --profile, not both.");
  }
  if (hasProfile) {
    return resolve(process.cwd(), opts.profile!.trim());
  }
  if (hasMap) {
    return resolve(process.cwd(), opts.map!.trim());
  }
  const envProfile = process.env.VFM_SOURCE_PROFILE_PATH?.trim();
  if (envProfile) {
    return resolve(process.cwd(), envProfile);
  }
  const envMap = process.env.VFM_HEADER_MAP_PATH?.trim();
  if (envMap) {
    return resolve(process.cwd(), envMap);
  }
  throw new Error("Pass --map or --profile, or set VFM_HEADER_MAP_PATH or VFM_SOURCE_PROFILE_PATH.");
}

function parseFileOptionsFromMap(map: { sheetName?: string; headerRow?: number; dataStartRow?: number }): ParseFileOptions {
  const out: ParseFileOptions = {};
  if (map.sheetName?.trim()) out.sheetName = map.sheetName.trim();
  if (map.headerRow != null && map.headerRow > 0) out.headerRow = map.headerRow;
  if (map.dataStartRow != null && map.dataStartRow > 0) out.dataStartRow = map.dataStartRow;
  return out;
}

function signerFullNameDisplay(normalized: NormalizedRowJson): string | null {
  const fromFull = toTitleCaseFromLower(normalized.full_name ?? null);
  if (fromFull) return fromFull;
  const joined = [normalized.first_name, normalized.last_name].filter(Boolean).join(" ").trim();
  return joined ? toTitleCaseFromLower(joined) : null;
}

function aggregateSummaryExtensions(prepared: { row_number: number; normalized: NormalizedRowJson }[]): Pick<
  SummaryReportJson,
  | "qa_counts"
  | "date_signed_min"
  | "date_signed_max"
  | "city_counts"
  | "state_counts"
  | "zip_counts"
  | "duplicate_within_file_count"
  | "rows_with_notes_count"
  | "non_jacksonville_city_count"
  | "future_signed_at_count"
> {
  const qa_counts: Record<string, number> = {};
  const city_counts: Record<string, number> = {};
  const state_counts: Record<string, number> = {};
  const zip_counts: Record<string, number> = {};
  const signedDates: string[] = [];
  let rows_with_notes_count = 0;
  let non_jacksonville_city_count = 0;
  let future_signed_at_count = 0;
  let duplicate_within_file_count = 0;

  for (const p of prepared) {
    const n = p.normalized;
    if (n.notes) rows_with_notes_count += 1;
    for (const f of n._qa_flags ?? []) {
      qa_counts[f] = (qa_counts[f] ?? 0) + 1;
      if (f === "NON_JACKSONVILLE_CITY") non_jacksonville_city_count += 1;
      if (f === "FUTURE_SIGNED_AT") future_signed_at_count += 1;
      if (f === "POSSIBLE_DUPLICATE_WITHIN_FILE") duplicate_within_file_count += 1;
    }
    if (n.city) city_counts[n.city] = (city_counts[n.city] ?? 0) + 1;
    if (n.state) state_counts[n.state] = (state_counts[n.state] ?? 0) + 1;
    if (n.zip) zip_counts[n.zip] = (zip_counts[n.zip] ?? 0) + 1;
    if (n.signed_at) signedDates.push(n.signed_at);
  }

  signedDates.sort();
  const date_signed_min = signedDates.length ? signedDates[0]! : null;
  const date_signed_max = signedDates.length ? signedDates[signedDates.length - 1]! : null;

  return {
    qa_counts,
    date_signed_min,
    date_signed_max,
    city_counts,
    state_counts,
    zip_counts,
    duplicate_within_file_count,
    rows_with_notes_count,
    non_jacksonville_city_count,
    future_signed_at_count,
  };
}

async function handleReportingAndSearchCli(opts: Opts): Promise<boolean> {
  const json = Boolean(opts.json);
  if (opts.reportBatch?.trim()) {
    const pool = createPool();
    try {
      const batchId = opts.reportBatch.trim();
      const outRel = opts.out?.trim() || join("tools", "voter-file-matcher", "reports", batchId);
      const outDir = resolve(process.cwd(), outRel);
      const { summary } = await writeBatchOperatorReport(pool, {
        batchId,
        outDir,
        json,
        includeSensitiveConsole: opts.includeSensitive === true,
      });
      if (json) {
        console.log(JSON.stringify({ report_batch: true, summary, out_dir: outDir }, null, 2));
      } else {
        console.log(
          JSON.stringify({
            report_batch: true,
            batch_id: summary.batch_id,
            total_rows: summary.total_rows,
            matched_total: summary.matched_total,
            slam_dunk_matched: summary.slam_dunk_matched,
            needs_review_total: summary.needs_review_total,
            not_found_total: summary.not_found_total,
            warnings: summary.warnings,
            out_dir: outDir,
          })
        );
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return true;
  }

  if (opts.reportPetition?.trim()) {
    const code = opts.reportPetition.trim();
    const outRel = opts.out?.trim() || join("tools", "voter-file-matcher", "reports", `petition-${code}`);
    const outDir = resolve(process.cwd(), outRel);
    const pool = createPool();
    try {
      const { summary } = await writePetitionOperatorReport(pool, { petitionCode: code, outDir });
      if (json) {
        console.log(JSON.stringify({ report_petition: true, summary, out_dir: outDir }, null, 2));
      } else {
        console.log(
          JSON.stringify({
            report_petition: true,
            petition_code: summary.petition_code,
            total_rows: summary.total_rows,
            matched_total: summary.matched_total,
            out_dir: outDir,
          })
        );
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return true;
  }

  if (opts.nextReviewRow === true) {
    const batchId = opts.batchId?.trim();
    if (!batchId) throw new Error("--batch-id is required for --next-review-row.");
    const pool = createPool();
    try {
      const row = await fetchNextReviewRow(pool, batchId);
      if (json) {
        console.log(JSON.stringify({ next_review_row: row }, null, 2));
      } else if (!row) {
        console.log("(no rows in review queue for this batch)");
      } else {
        const n = row.normalized_json;
        console.log(
          [
            `row_number=${row.row_number}`,
            `match_status=${row.match_status}`,
            `review_status=${row.review_status}`,
            `candidates=${row.candidate_count}`,
            `candidate_voter_ids=${JSON.stringify(row.candidate_voter_ids ?? [])}`,
            `qa_flags=${JSON.stringify(row.qa_flags ?? [])}`,
            `notes=${row.notes ?? ""}`,
          ].join("\n")
        );
        if (opts.includeSensitive === true) {
          console.log(
            [
              `first_name=${n.first_name ?? ""}`,
              `last_name=${n.last_name ?? ""}`,
              `address=${row.signer_address ?? ""}`,
              `city=${row.signer_city ?? ""}`,
              `state=${row.signer_state ?? ""}`,
              `zip=${row.signer_zip ?? ""}`,
              `signed_at=${row.signed_at ?? ""}`,
            ].join("\n")
          );
        }
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return true;
  }

  if (opts.searchVotersForRow === true) {
    const batchId = opts.batchId?.trim();
    if (!batchId) throw new Error("--batch-id is required for --search-voters-for-row.");
    const rowNum = opts.rowNumber;
    if (rowNum == null || !Number.isFinite(rowNum)) {
      throw new Error("--row-number is required for --search-voters-for-row.");
    }
    const mapPath = resolveMapOrProfilePath(opts);
    const canonicalTable = process.env.VFM_CANONICAL_TABLE?.trim() ?? "";
    if (!canonicalTable && !readMatchSourceTableEnv()) {
      throw new Error("Set VFM_CANONICAL_TABLE or VFM_MATCH_SOURCE_TABLE for --search-voters-for-row.");
    }
    const mapFile = await loadHeaderMapFile(mapPath);
    const cols = buildCanonicalColumnMap(mapFile);
    const pool = createPool();
    try {
      const { candidates, normalized } = await searchVotersForRow(pool, {
        batchId,
        rowNumber: rowNum,
        limit: opts.limit,
        lastName: opts.searchLastName,
        firstName: opts.searchFirstName,
        city: opts.searchCity,
        zip: opts.searchZip,
        address: opts.searchAddress,
        includeAddress: opts.omitAddressSearch !== true && opts.includeAddress !== false,
        canonicalTableQualified: canonicalTable,
        cols,
      });
      if (json) {
        console.log(JSON.stringify({ search_voters_for_row: true, normalized, candidates }, null, 2));
      } else {
        console.log(`candidates_returned=${candidates.length} (max ${opts.limit ?? 20})`);
        for (const c of candidates) {
          console.log(
            [
              `voter_id=${c.voter_id}`,
              `score=${c.candidate_score}`,
              `reason=${c.candidate_reason}`,
              `name=${c.first_name} ${c.last_name}`,
              `city=${c.city}`,
              `zip5=${c.zip5}`,
            ].join(" | ")
          );
        }
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return true;
  }

  if (opts.reviewProgress === true) {
    const batchId = opts.batchId?.trim();
    if (!batchId) throw new Error("--batch-id is required for --review-progress.");
    const pool = createPool();
    try {
      const p = await runReviewProgress(pool, batchId);
      if (json) console.log(JSON.stringify({ review_progress: p }, null, 2));
      else console.log(JSON.stringify({ review_progress: p }));
    } finally {
      await pool.end().catch(() => undefined);
    }
    return true;
  }

  return false;
}

async function handleReviewCli(opts: Opts): Promise<boolean> {
  const json = Boolean(opts.json);
  const approve = opts.approveRow === true || opts.approveReviewCandidate === true;
  const reject = opts.rejectRow === true || opts.rejectReviewRow === true;
  const nmi = opts.needsMoreInfo === true || opts.skipReviewRow === true;
  const hasReview =
    Boolean(opts.batchSummary?.trim()) ||
    opts.reviewQueue === true ||
    opts.exportReviewQueue === true ||
    approve ||
    reject ||
    nmi ||
    opts.addReviewNote === true;
  if (!hasReview) return false;

  const pool = createPool();
  try {
    if (opts.batchSummary?.trim()) {
      const bid = opts.batchSummary.trim();
      const s = await fetchBatchSummary(pool, bid);
      if (!s) throw new Error(`Batch not found: ${bid}`);
      if (json) {
        console.log(JSON.stringify(s, null, 2));
      } else {
        console.log(`batch_id:          ${s.batch_id}`);
        console.log(`file_name:         ${s.file_name ?? ""}`);
        console.log(`project_key:       ${s.project_key ?? ""}`);
        console.log(`petition_code:     ${s.petition_code ?? ""}`);
        console.log(`petition_id:       ${s.petition_id ?? ""}`);
        console.log(`total_rows:        ${s.total_rows ?? 0}`);
        console.log(`batch_status:      ${s.batch_status ?? ""}`);
        console.log(`created_at:        ${s.created_at ?? ""}`);
        console.log(`completed_at:      ${s.completed_at ?? ""}`);
        console.log(`match_status_counts: ${JSON.stringify(s.match_status_counts)}`);
        console.log(`review_status_counts: ${JSON.stringify(s.review_status_counts)}`);
        console.log(`permanent_signatures_attached_count: ${s.permanent_signatures_attached_count}`);
        console.log(`reports_directory: ${s.reports_directory ?? "(none)"}`);
        if (s.migration_002_applied) {
          console.log(`review_queue_count: ${s.review_queue_count ?? 0}`);
          console.log(`approved_count: ${s.approved_count ?? 0}`);
          console.log(`rejected_count: ${s.rejected_count ?? 0}`);
          console.log(`needs_more_info_count: ${s.needs_more_info_count ?? 0}`);
          console.log(`manually_attached_count: ${s.manually_attached_count ?? 0}`);
        }
      }
      return true;
    }

    const batchId = opts.batchId?.trim();
    if (!batchId) {
      throw new Error("--batch-id is required for this command (except --batch-summary <uuid>).");
    }

    if (opts.reviewQueue === true) {
      const statuses = parseCsvStatuses(opts.status, DEFAULT_REVIEW_QUEUE_STATUSES);
      const limitRaw = opts.limit ?? 50;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
      const rows = await fetchReviewQueue(pool, { batchId, matchStatuses: statuses, limit });
      if (json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        for (const r of rows) {
          const n = r.normalized_json;
          const full = signerFullNameDisplay(n) ?? "";
          console.log(
            [
              `row=${r.row_number}`,
              `match=${r.match_status}`,
              `review=${r.review_status}`,
              `candidates=${r.candidate_count}`,
              `ids=${JSON.stringify(r.candidate_voter_ids)}`,
              `name=${full}`,
              `city=${n.city ?? ""}`,
              `county=${n.county ?? ""}`,
              `notes=${r.notes ?? ""}`,
            ].join(" | ")
          );
        }
        if (rows.length === 0) console.log("(no rows in review queue for this filter)");
      }
      return true;
    }

    if (opts.exportReviewQueue === true) {
      const statuses = parseCsvStatuses(opts.status, DEFAULT_REVIEW_QUEUE_STATUSES);
      const outPath =
        opts.out?.trim() ||
        join(process.cwd(), "tools", "voter-file-matcher", "reports", batchId, "review_queue.csv");
      const p = await exportReviewQueueCsv(pool, { batchId, matchStatuses: statuses, outPath });
      console.log(json ? JSON.stringify({ ok: true, path: p }) : `Wrote ${p}`);
      return true;
    }

    const rowNum = opts.rowNumber;
    if (rowNum == null || !Number.isFinite(rowNum)) {
      throw new Error("--row-number is required for approve / reject / needs-more-info / add-review-note.");
    }
    const reviewedBy = opts.reviewedBy?.trim();
    if (!reviewedBy) {
      throw new Error('--reviewed-by is required (e.g. --reviewed-by "Jane Operator").');
    }
    const note = opts.note?.trim() ?? "";

    if (approve) {
      const voterId = opts.voterId?.trim();
      if (!voterId) throw new Error("--voter-id is required for --approve-row.");
      const mapPath = resolveMapOrProfilePath(opts);
      const canonicalTable = process.env.VFM_CANONICAL_TABLE?.trim() ?? "";
      if (!canonicalTable && !readMatchSourceTableEnv()) {
        throw new Error("Set VFM_CANONICAL_TABLE or VFM_MATCH_SOURCE_TABLE for --approve-row.");
      }
      const mapFile = await loadHeaderMapFile(mapPath);
      const cols = buildCanonicalColumnMap(mapFile);
      const r = await runApproveRow(pool, {
        batchId,
        rowNumber: rowNum,
        voterId,
        reviewedBy,
        note,
        canonicalTableQualified: canonicalTable,
        cols,
      });
      if (json) console.log(JSON.stringify(r.summary, null, 2));
      else {
        const s = r.summary;
        for (const [k, v] of Object.entries(s)) console.log(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      }
      return true;
    }

    if (reject) {
      const r = await runRejectRow(pool, { batchId, rowNumber: rowNum, reviewedBy, note });
      if (json) console.log(JSON.stringify(r.summary, null, 2));
      else {
        for (const [k, v] of Object.entries(r.summary)) console.log(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      }
      return true;
    }

    if (nmi) {
      const r = await runNeedsMoreInfo(pool, { batchId, rowNumber: rowNum, reviewedBy, note });
      if (json) console.log(JSON.stringify(r.summary, null, 2));
      else {
        for (const [k, v] of Object.entries(r.summary)) console.log(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      }
      return true;
    }

    if (opts.addReviewNote === true) {
      const r = await runAddReviewNote(pool, { batchId, rowNumber: rowNum, reviewedBy, note });
      if (json) console.log(JSON.stringify(r.summary, null, 2));
      else {
        for (const [k, v] of Object.entries(r.summary)) console.log(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      }
      return true;
    }

    throw new Error("Unhandled review CLI branch.");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const program = new Command();
program
  .option("--file <path>", "Path to CSV or Excel (required for import; not for --validate-config alone)")
  .option("--project <key>", "project_key (else VFM_PROJECT_KEY)")
  .option("--map <path>", "Header map JSON (else VFM_HEADER_MAP_PATH)")
  .option("--profile <path>", "Source profile JSON (same shape as map + profile fields; else VFM_SOURCE_PROFILE_PATH)")
  .option("--petition-code <code>", "Petition code (else VFM_PETITION_CODE)")
  .option("--petition-name <name>", "Petition display name (else VFM_PETITION_NAME)")
  .option("--source-label <label>", "Optional source label stored on batch")
  .option("--created-by <id>", "Optional operator id / label")
  .option("--dry-run", "Parse file only; no database or report files", false)
  .option("--preflight-file", "Parse + map + normalize + QA only (no DB, safe summary)", false)
  .option("--chunk-size <n>", "Rows per chunk", (v) => Number.parseInt(v, 10))
  .option("--validate-config", "Validate env + map file only (no DB unless --validate-db)", false)
  .option("--validate-db", "With --validate-config, also verify tables and canonical table in DB", false)
  .option("--inspect-voter-source", "List resolved table columns + standard match-source contract (no row data)", false)
  .option("--match-readiness", "Preflight file + DB match-source checks (no writes)", false)
  .option("--candidate-probe", "Sample rows: run match queries, aggregate counts only (no writes)", false)
  .option("--discover-voter-schema", "information_schema only: classify canonical (+ optional related) columns (no row data)", false)
  .option("--plan-match-source", "Write draft match-source mapping JSON from schema discovery (no DB writes except reads)", false)
  .option("--emit-match-source-sql", "Emit CREATE OR REPLACE VIEW SQL from plan file (does not execute)", false)
  .option("--apply-match-source-sql", "Execute reviewed CREATE VIEW SQL (requires --confirm-apply-match-source)", false)
  .option("--confirm-apply-match-source", "Acknowledge explicit apply of --sql view definition", false)
  .option("--canonical-table <q>", 'Qualified canonical table (default: VFM_CANONICAL_TABLE)')
  .option("--include-related", "With --discover-voter-schema / --plan-match-source: scan related public tables by name/columns", false)
  .option(
    "--plan <path>",
    "Plan JSON path: match-source (--emit-match-source-sql) or guarded import plan (--review-import-plan / --execute-import-plan / --inspect-import-plan)"
  )
  .option("--sql <path>", "SQL file for --apply-match-source-sql")
  .option(
    "--target <q>",
    "Qualified output view name for plan/emit/apply safety check",
    "public.voter_match_source"
  )
  .option("--batch-summary <uuid>", "Print import batch summary (DB)")
  .option("--review-queue", "List rows needing human review for a batch", false)
  .option("--export-review-queue", "Export review queue to CSV", false)
  .option("--approve-row", "Manually approve match and attach signature", false)
  .option("--reject-row", "Reject match without changing signatures", false)
  .option("--needs-more-info", "Mark row as needs more info", false)
  .option("--add-review-note", "Append audit note (optional signature event)", false)
  .option("--batch-id <uuid>", "Import batch id (review commands)")
  .option("--status <csv>", "Comma-separated match_status filter for queue export/list")
  .option("--limit <n>", "Max rows for --review-queue", (v) => Number.parseInt(v, 10))
  .option("--json", "JSON output for review / batch-summary", false)
  .option("--out <path>", "Output path for --export-review-queue")
  .option("--row-number <n>", "import_rows.row_number (0-based as stored)", (v) => Number.parseInt(v, 10))
  .option("--voter-id <id>", "Canonical voter id for --approve-row")
  .option("--reviewed-by <name>", "Reviewer label for audit trail")
  .option("--note <text>", "Review note / reason")
  .option("--report-batch <uuid>", "Write local CSV/XLSX/JSON operator pack for an import batch (no console PII unless --include-sensitive)")
  .option("--report-petition <code>", "Aggregate report across batches for a petition_code")
  .option("--next-review-row", "Print next batch_review_queue_enriched row (use --include-sensitive for signer fields on console)", false)
  .option("--search-voters-for-row", "Search match source / canonical for candidates for a batch row (read-only)", false)
  .option("--approve-review-candidate", "Same as --approve-row (manual attach + audit)", false)
  .option("--skip-review-row", "Alias for --needs-more-info", false)
  .option("--reject-review-row", "Alias for --reject-row", false)
  .option("--review-progress", "Safe progress counts for a batch", false)
  .option("--include-sensitive", "Allow extra signer fields on console for local review commands", false)
  .option("--search-last-name <text>", "Override last name for --search-voters-for-row")
  .option("--search-first-name <text>", "Override first name for --search-voters-for-row")
  .option("--search-city <text>", "Override city for --search-voters-for-row")
  .option("--search-zip <text>", "Override ZIP for --search-voters-for-row")
  .option("--search-address <text>", "Override address for --search-voters-for-row")
  .option("--omit-address-search", "With --search-voters-for-row: skip address-based strategies", false)
  .option(
    "--prepare-import-plan",
    "Preflight + readiness + candidate probe; write import plan JSON (no import_rows / signatures)",
    false
  )
  .option("--review-import-plan", "Mark import plan REVIEWED after human check (requires --plan)", false)
  .option(
    "--execute-import-plan",
    "Run full import from a REVIEWED plan (requires --plan --confirm-execute-import)",
    false
  )
  .option("--list-import-plans", "List import_plans rows from DB (safe metadata only)", false)
  .option("--inspect-import-plan", "Print safe summary of import plan JSON (--plan)", false)
  .option(
    "--confirm-direct-import",
    "Bypass guarded-import requirement for petition-mail-list-share-v1 direct imports (non-dry-run only)",
    false
  )
  .option("--confirm-execute-import", "Required with --execute-import-plan", false)
  .option("--save-plan-db", "With import plan commands: persist import_plans row (requires migration 004)", false)
  .option(
    "--allow-review-with-warnings",
    "With --review-import-plan: allow REVIEWED when decision.ready_for_import is false",
    false
  )
  .option(
    "--allow-file-hash-mismatch",
    "With --execute-import-plan: allow source file SHA-256 drift vs plan (dangerous)",
    false
  )
  .option(
    "--candidate-probe-limit <n>",
    "Sample size for --prepare-import-plan candidate probe",
    (v) => Number.parseInt(v, 10)
  )
  .option(
    "--import-plan-status <s>",
    "With --list-import-plans: filter by operator_review_status (e.g. REVIEWED, EXECUTED)"
  )
  .option("--operator-note <text>", "Optional note stored on the plan JSON when using --prepare-import-plan")
  .option("--upsert-initiative", "Create or update ballot initiative (petition) metadata in DB", false)
  .option("--list-initiatives", "List initiatives with signature counts (safe metadata)", false)
  .option("--initiative-summary <code>", "Rollup summary for one petition_code / initiative")
  .option("--initiative-scope <s>", "CITY | COUNTY | STATEWIDE | DISTRICT | OTHER (with --upsert-initiative or --auto-create-initiative)")
  .option("--reporting-geo <s>", "WARD | COUNTY | PRECINCT | DISTRICT | CITY | NONE (with --upsert-initiative or auto-create)")
  .option("--target-signature-count <n>", "Optional goal count for progress reporting", (v) => Number.parseInt(v, 10))
  .option("--initiative-notes <text>", "Optional operator notes stored on petitions.notes")
  .option(
    "--auto-create-initiative",
    "With --prepare-import-plan, --execute-import-plan, or direct import: create initiative if missing (requires name + reporting geo when creating)",
    false
  )
  .parse(process.argv);

type Prepared = {
  row_number: number;
  chunk_number: number;
  raw: RawRowJson;
  normalized: NormalizedRowJson;
};

async function main(): Promise<void> {
  const opts = program.opts() as Opts;

  if (opts.upsertInitiative === true) {
    const code = (opts.petitionCode ?? process.env.VFM_PETITION_CODE)?.trim();
    if (!code) throw new Error("--petition-code (or VFM_PETITION_CODE) is required with --upsert-initiative.");
    const pool = createPool();
    try {
      const existing = await fetchInitiativeByCode(pool, code);
      const nameRaw = (opts.petitionName ?? process.env.VFM_PETITION_NAME)?.trim();
      const name = nameRaw && nameRaw.length > 0 ? nameRaw : existing?.petition_name ?? "";
      if (!name) {
        throw new Error(
          "--petition-name (or VFM_PETITION_NAME) is required when the initiative does not already exist in the database."
        );
      }
      const project = (opts.project ?? process.env.VFM_PROJECT_KEY)?.trim() ?? null;
      const r = await upsertInitiative(pool, {
        petitionCode: code,
        petitionName: name,
        projectKey: project,
        initiativeScope: opts.initiativeScope?.trim() ?? null,
        reportingGeo: opts.reportingGeo?.trim() ?? null,
        targetSignatureCount:
          opts.targetSignatureCount != null && Number.isFinite(opts.targetSignatureCount)
            ? opts.targetSignatureCount
            : null,
        notes: opts.initiativeNotes?.trim() ?? null,
      });
      console.log(
        JSON.stringify(
          {
            upsert_initiative: true,
            petition_code: code,
            petition_id: r.petition_id,
            created: r.created,
          },
          null,
          2
        )
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (opts.listInitiatives === true) {
    const pool = createPool();
    try {
      const limitRaw = opts.limit ?? 100;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
      const rows = await listInitiatives(pool, {
        projectKey: opts.project?.trim() ?? process.env.VFM_PROJECT_KEY?.trim() ?? null,
        status: opts.status?.trim() ?? null,
        limit,
      });
      if (opts.json === true) {
        console.log(JSON.stringify({ list_initiatives: true, rows }, null, 2));
      } else {
        for (const r of rows) {
          console.log(
            [
              `code=${r.petition_code}`,
              `name=${r.petition_name}`,
              `scope=${r.initiative_scope ?? ""}`,
              `reporting_geo=${r.reporting_geo ?? ""}`,
              `target=${r.target_signature_count ?? ""}`,
              `signatures=${r.total_signatures}`,
              `latest=${r.latest_signature_at ?? ""}`,
            ].join(" | ")
          );
        }
        if (rows.length === 0) console.log("(no initiatives)");
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  const initiativeSummaryCode = opts.initiativeSummary?.trim();
  if (initiativeSummaryCode) {
    const pool = createPool();
    try {
      const s = await getInitiativeSummary(pool, initiativeSummaryCode);
      console.log(JSON.stringify(opts.json === true ? { initiative_summary: true, ...s } : s, null, 2));
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (opts.applyMatchSourceSql === true) {
    if (opts.confirmApplyMatchSource !== true) {
      throw new Error("Refusing to execute SQL: pass --confirm-apply-match-source to acknowledge explicit apply.");
    }
    const sqlRel = opts.sql?.trim();
    if (!sqlRel) throw new Error("Pass --sql <path> to the CREATE OR REPLACE VIEW file for --apply-match-source-sql.");
    const sqlPath = resolve(process.cwd(), sqlRel);
    const targetQ = (opts.target ?? "public.voter_match_source").trim();
    const sqlText = await readSqlFile(sqlPath);
    assertSafeMatchSourceViewSql(sqlText, targetQ);
    const pool = createPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sqlText);
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
    try {
      const inspect = await inspectVoterMatchSource(pool);
      console.log(
        JSON.stringify(
          { apply_match_source_sql: true, ok: true, target: targetQ, inspect_voter_source: inspect },
          null,
          2
        )
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (opts.prepareImportPlan === true) {
    if (!opts.file?.trim()) throw new Error("--file is required for --prepare-import-plan.");
    const filePath = resolve(process.cwd(), opts.file.trim());
    const projectKey = (opts.project ?? process.env.VFM_PROJECT_KEY)?.trim();
    if (!projectKey) throw new Error("--project or VFM_PROJECT_KEY is required for --prepare-import-plan.");
    const petitionCode = (opts.petitionCode ?? process.env.VFM_PETITION_CODE)?.trim();
    if (!petitionCode) throw new Error("--petition-code or VFM_PETITION_CODE is required for --prepare-import-plan.");
    const petitionNameRaw = (opts.petitionName ?? process.env.VFM_PETITION_NAME)?.trim();
    const petitionName = petitionNameRaw && petitionNameRaw.length > 0 ? petitionNameRaw : petitionCode;
    const mapPath = resolveMapOrProfilePath(opts);
    const limRaw = opts.candidateProbeLimit ?? 25;
    const candidateProbeLimit = Number.isFinite(limRaw) && limRaw > 0 ? limRaw : 25;
    const pool = createPool();
    try {
      const { plan, written } = await prepareImportPlan(pool, {
        filePath,
        mapPath,
        projectKey,
        petitionCode,
        petitionName,
        sourceLabel: opts.sourceLabel?.trim() ?? null,
        candidateProbeLimit,
        operatorNote: opts.operatorNote?.trim() ?? null,
        outPath: opts.out?.trim() ? resolve(process.cwd(), opts.out.trim()) : undefined,
        autoCreateInitiative: opts.autoCreateInitiative === true,
        initiativeScope: opts.initiativeScope?.trim() ?? null,
        reportingGeo: opts.reportingGeo?.trim() ?? null,
        targetSignatureCount:
          opts.targetSignatureCount != null && Number.isFinite(opts.targetSignatureCount)
            ? opts.targetSignatureCount
            : null,
        initiativeNotes: opts.initiativeNotes?.trim() ?? null,
      });
      if (opts.savePlanDb === true) {
        await saveImportPlanToDb(pool, plan);
      }
      console.log(
        JSON.stringify(
          {
            prepare_import_plan: true,
            written,
            plan_key: plan.plan_key,
            ready_for_import: plan.decision.ready_for_import,
            projected_matching_quality: plan.decision.projected_matching_quality,
            blocking_reasons: plan.decision.blocking_reasons,
          },
          null,
          2
        )
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (opts.reviewImportPlan === true) {
    const p = opts.plan?.trim();
    if (!p) throw new Error("--plan is required for --review-import-plan.");
    const planPath = resolve(process.cwd(), p);
    const reviewedBy = opts.reviewedBy?.trim();
    if (!reviewedBy) throw new Error("--reviewed-by is required for --review-import-plan.");
    await reviewImportPlan(planPath, {
      reviewedBy,
      note: opts.note?.trim() ?? null,
      allowReviewWithWarnings: opts.allowReviewWithWarnings === true,
      savePlanDb: opts.savePlanDb === true,
    });
    console.log(JSON.stringify({ review_import_plan: true, plan: planPath }, null, 2));
    return;
  }

  if (opts.executeImportPlan === true) {
    if (opts.confirmExecuteImport !== true) {
      throw new Error("Refusing to execute import plan: pass --confirm-execute-import.");
    }
    const p = opts.plan?.trim();
    if (!p) throw new Error("--plan is required for --execute-import-plan.");
    const planPath = resolve(process.cwd(), p);
    const chunkSizeRaw = opts.chunkSize ?? Number.parseInt(process.env.VFM_CHUNK_SIZE ?? "500", 10);
    const chunkSize = Number.isFinite(chunkSizeRaw) && chunkSizeRaw > 0 ? chunkSizeRaw : 500;
    const summary = await executeImportPlanFromDisk({
      planPath,
      allowHashMismatch: opts.allowFileHashMismatch === true,
      savePlanDb: opts.savePlanDb === true,
      createdBy: opts.createdBy?.trim() ?? null,
      chunkSize,
      autoCreateInitiative: opts.autoCreateInitiative === true,
      initiativeScope: opts.initiativeScope?.trim() ?? null,
      reportingGeo: opts.reportingGeo?.trim() ?? null,
      targetSignatureCount:
        opts.targetSignatureCount != null && Number.isFinite(opts.targetSignatureCount)
          ? opts.targetSignatureCount
          : null,
      initiativeNotes: opts.initiativeNotes?.trim() ?? null,
    });
    console.log(JSON.stringify({ execute_import_plan: true, ...summary }, null, 2));
    return;
  }

  if (opts.listImportPlans === true) {
    const pool = createPool();
    try {
      if (!(await importPlansTableExists(pool))) {
        const msg =
          "Apply migration 004_import_plan_guardrails.sql to enable DB-backed import plans.";
        if (opts.json === true) {
          console.log(JSON.stringify({ list_import_plans: false, message: msg }, null, 2));
        } else {
          console.log(msg);
        }
        return;
      }
      const limitRaw = opts.limit ?? 25;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25;
      const rows = await listImportPlansFromDb(pool, {
        petitionCode: opts.petitionCode?.trim(),
        projectKey: opts.project?.trim(),
        status: opts.importPlanStatus?.trim(),
        limit,
      });
      if (opts.json === true) {
        console.log(JSON.stringify({ list_import_plans: true, rows }, null, 2));
      } else {
        for (const r of rows) {
          console.log(
            [
              `plan_key=${r.plan_key}`,
              `project=${r.project_key}`,
              `petition=${r.petition_code}`,
              `file=${r.source_file_name}`,
              `hash=${r.source_file_hash_short}`,
              `rows=${r.row_count ?? ""}`,
              `ready=${r.ready_for_import}`,
              `status=${r.operator_review_status}`,
              `batch=${r.executed_import_batch_id ?? ""}`,
              `created=${r.created_at}`,
              `executed=${r.executed_at ?? ""}`,
            ].join(" | ")
          );
        }
        if (rows.length === 0) console.log("(no import_plans rows for this filter)");
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (opts.inspectImportPlan === true) {
    const p = opts.plan?.trim();
    if (!p) throw new Error("--plan is required for --inspect-import-plan.");
    const plan = await readImportPlan(resolve(process.cwd(), p));
    const s = inspectImportPlanSummary(plan);
    console.log(JSON.stringify(opts.json === true ? { inspect_import_plan: true, ...s } : s, null, 2));
    return;
  }

  if (opts.discoverVoterSchema === true) {
    const canonical = opts.canonicalTable?.trim() || process.env.VFM_CANONICAL_TABLE?.trim();
    if (!canonical) {
      throw new Error("Pass --canonical-table or set VFM_CANONICAL_TABLE for --discover-voter-schema.");
    }
    const pool = createPool();
    try {
      const disc = await discoverVoterSchema(pool, canonical, opts.includeRelated === true);
      if (opts.json === true) {
        console.log(JSON.stringify({ discover_voter_schema: true, ...disc }, null, 2));
      } else {
        console.log(`resolved_table: ${disc.resolved_table}`);
        for (const col of disc.columns) {
          console.log(
            `${col.column_name}\t${col.data_type}\tnullable=${col.is_nullable}\t${col.logical_classification}`
          );
        }
        if (disc.related_tables?.length) {
          console.log("\n-- related tables (schema hints only; verify joins manually) --");
          for (const rt of disc.related_tables) {
            console.log(`\n${rt.qualified_table}\t${rt.table_type}\t${rt.match_reason}`);
            for (const col of rt.columns) {
              console.log(`  ${col.column_name}\t${col.data_type}\t${col.logical_classification}`);
            }
            if (rt.possible_join_keys_with_canonical.length) {
              console.log(`  possible_join_keys: ${JSON.stringify(rt.possible_join_keys_with_canonical)}`);
            }
          }
        }
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (opts.planMatchSource === true) {
    const canonical = opts.canonicalTable?.trim() || process.env.VFM_CANONICAL_TABLE?.trim();
    if (!canonical) {
      throw new Error("Pass --canonical-table or set VFM_CANONICAL_TABLE for --plan-match-source.");
    }
    const targetQ = (opts.target ?? "public.voter_match_source").trim();
    const outRel = opts.out?.trim() || join("tools", "voter-file-matcher", "reports", "match-source-plan.json");
    const outPath = resolve(process.cwd(), outRel);
    await mkdir(dirname(outPath), { recursive: true });
    const pool = createPool();
    try {
      const plan = await buildMatchSourcePlan(pool, {
        canonicalQualified: canonical,
        targetMatchSource: targetQ,
        includeRelated: opts.includeRelated === true,
      });
      await writeFile(outPath, JSON.stringify(plan, null, 2), "utf8");
      if (opts.json === true) {
        console.log(JSON.stringify({ plan_match_source: true, written: outPath, plan }, null, 2));
      } else {
        console.log(
          JSON.stringify(
            {
              plan_match_source: true,
              written: outPath,
              missing_or_low_confidence: plan.missing_or_low_confidence.length,
              warnings: plan.warnings,
            },
            null,
            2
          )
        );
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (opts.emitMatchSourceSql === true) {
    const planRel = opts.plan?.trim() || join("tools", "voter-file-matcher", "reports", "match-source-plan.json");
    const planPath = resolve(process.cwd(), planRel);
    const targetQ = (opts.target ?? "public.voter_match_source").trim();
    const outRel =
      opts.out?.trim() || join("tools", "voter-file-matcher", "reports", "create-voter-match-source.sql");
    const outPath = resolve(process.cwd(), outRel);
    const plan = await loadMatchSourcePlan(planPath);
    const sql = emitMatchSourceViewSql(plan, targetQ);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, sql, "utf8");
    console.log(
      JSON.stringify({ emit_match_source_sql: true, plan: planPath, written: outPath, target: targetQ }, null, 2)
    );
    return;
  }

  if (opts.inspectVoterSource === true) {
    const pool = createPool();
    try {
      const r = await inspectVoterMatchSource(pool);
      if (opts.json === true) {
        console.log(JSON.stringify({ inspect_voter_source: true, ...r }, null, 2));
      } else {
        console.log(`source_mode: ${r.source_mode}`);
        console.log(`resolved_table: ${r.resolved_table}`);
        console.log(`relation_exists: ${r.relation_exists}`);
        console.log(`required_missing: ${r.standard_column_report.required_missing.join(", ") || "(none)"}`);
        console.log(`recommended_missing: ${r.standard_column_report.recommended_missing.join(", ") || "(none)"}`);
        console.log(`column_count: ${r.column_names.length}`);
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
    return;
  }

  if (opts.validateConfig || opts.validateDb) {
    const mapPath = resolveMapOrProfilePath(opts);
    const cfg = await runValidateConfig(mapPath);
    const out: Record<string, unknown> = { validate_config: cfg };
    if (opts.validateDb) {
      if (!cfg.ok) {
        console.log(
          JSON.stringify(
            {
              ...out,
              validate_db: { ok: false, skipped: true, reason: "Fix validate_config errors before --validate-db." },
              ok: false,
            },
            null,
            2
          )
        );
        process.exit(1);
      }
      const ct = process.env.VFM_CANONICAL_TABLE?.trim();
      const ms = readMatchSourceTableEnv();
      if (!ct && !ms) {
        console.log(
          JSON.stringify(
            {
              ...out,
              validate_db: {
                ok: false,
                errors: ["Set VFM_CANONICAL_TABLE and/or VFM_MATCH_SOURCE_TABLE for --validate-db."],
              },
              ok: false,
            },
            null,
            2
          )
        );
        process.exit(1);
      }
      const db = await runValidateDb(mapPath);
      out.validate_db = db;
      const ok = cfg.ok && db.ok;
      console.log(JSON.stringify({ ...out, ok }, null, 2));
      process.exit(ok ? 0 : 1);
    }
    console.log(JSON.stringify({ ...out, ok: cfg.ok }, null, 2));
    process.exit(cfg.ok ? 0 : 1);
  }

  if (await handleReportingAndSearchCli(opts)) {
    return;
  }

  if (await handleReviewCli(opts)) {
    return;
  }

  if (opts.matchReadiness === true || opts.candidateProbe === true) {
    const mapPath = resolveMapOrProfilePath(opts);
    if (!opts.file?.trim()) {
      throw new Error("Pass --file for --match-readiness / --candidate-probe.");
    }
    const filePath = resolve(process.cwd(), opts.file.trim());
    const mapFile = await loadHeaderMapFile(mapPath);
    const buf = await readFile(filePath);
    const sheet: ParsedSheet = parseVoterBuffer(buf, filePath, parseFileOptionsFromMap(mapFile));

    if (opts.matchReadiness === true) {
      const pf = runPreflightOnSheet(sheet, filePath, mapFile);
      const pool = createPool();
      try {
        const mr = await evaluateMatchReadiness(pool, pf, mapFile);
        const suggested = mr.suggested_next_steps ?? [];
        console.log(
          JSON.stringify(
            {
              match_readiness: true,
              file_preflight_ready: mr.file_preflight_ready,
              db_match_source_ready: mr.db_match_source_ready,
              projected_matching_quality: mr.projected_matching_quality,
              reasons: mr.reasons,
              suggested_next_steps: suggested,
              row_count: mr.row_count,
              mapped_fields: mr.mapped_fields,
              qa_counts: mr.qa_counts,
              match_source_mode: mr.match_source_mode,
              missing_required_db_fields: mr.missing_required_db_fields,
              missing_recommended_db_fields: mr.missing_recommended_db_fields,
            },
            null,
            2
          )
        );
      } finally {
        await pool.end().catch(() => undefined);
      }
      return;
    }

    if (opts.candidateProbe === true) {
      const canonicalTable = process.env.VFM_CANONICAL_TABLE?.trim();
      if (!canonicalTable) {
        throw new Error("VFM_CANONICAL_TABLE is required for --candidate-probe (matcher resolution).");
      }
      const limitRaw = opts.limit ?? 25;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25;
      const pool = createPool();
      try {
        const agg = await evaluateCandidateProbe(pool, canonicalTable, mapFile, sheet, limit);
        console.log(JSON.stringify({ candidate_probe: true, ...agg }, null, 2));
      } finally {
        await pool.end().catch(() => undefined);
      }
      return;
    }
  }

  const mapPath = resolveMapOrProfilePath(opts);

  if (!opts.file?.trim()) {
    throw new Error("Pass --file for import or preflight, or use --validate-config (see README).");
  }

  const filePath = resolve(process.cwd(), opts.file);

  if (opts.preflightFile) {
    const mapFile = await loadHeaderMapFile(mapPath);
    const buf = await readFile(filePath);
    const pOpts = parseFileOptionsFromMap(mapFile);
    const sheet: ParsedSheet = parseVoterBuffer(buf, filePath, pOpts);
    const summary = runPreflightOnSheet(sheet, filePath, mapFile);
    console.log(JSON.stringify({ preflight: true, ...summary }, null, 2));
    return;
  }

  const petitionCode = (opts.petitionCode ?? process.env.VFM_PETITION_CODE)?.trim();
  if (!petitionCode) throw new Error("Pass --petition-code or set VFM_PETITION_CODE");

  const petitionNameRaw = (opts.petitionName ?? process.env.VFM_PETITION_NAME)?.trim();
  const petitionName = petitionNameRaw && petitionNameRaw.length > 0 ? petitionNameRaw : petitionCode;

  const projectKey = loadProjectKey(opts.project);
  const canonicalTable =
    opts.dryRun === true ? process.env.VFM_CANONICAL_TABLE?.trim() || "(unset)" : loadCanonicalTable();
  const mapFile = await loadHeaderMapFile(mapPath);

  const chunkSizeRaw = opts.chunkSize ?? Number.parseInt(process.env.VFM_CHUNK_SIZE ?? "500", 10);
  const chunkSize = Number.isFinite(chunkSizeRaw) && chunkSizeRaw > 0 ? chunkSizeRaw : 500;

  const buf = await readFile(filePath);
  const pOpts = parseFileOptionsFromMap(mapFile);
  const sheet: ParsedSheet = parseVoterBuffer(buf, filePath, pOpts);

  if (opts.dryRun) {
    let mapping_smoke: Record<string, unknown> | null = null;
    if (sheet.rows.length > 0) {
      const dupProbe = processMappedRow(mapFile, sheet.headers, sheet.rows[0]!);
      mapping_smoke = {
        normalized_keys: Object.keys(dupProbe.normalized).filter((k) => {
          const v = (dupProbe.normalized as Record<string, unknown>)[k];
          return v != null && v !== "";
        }),
        raw_header_count: sheet.headers.length,
        qa_flags_sample: dupProbe.normalized._qa_flags ?? [],
      };
    }
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          file: basename(filePath),
          row_count: sheet.rows.length,
          column_count: sheet.headers.length,
          chunk_size: chunkSize,
          petition_code: petitionCode,
          petition_name: petitionName,
          project_key: projectKey,
          canonical_table: canonicalTable,
          match_source_mode: getMatchSourceMode(),
          source_profile: mapFile.profileName ?? null,
          mapping_smoke,
        },
        null,
        2
      )
    );
    return;
  }

  if (
    mapFile.profileName === "petition-mail-list-share-v1" &&
    opts.confirmDirectImport !== true &&
    opts.autoCreateInitiative !== true
  ) {
    const pool = createPool();
    try {
      const pet = await fetchInitiativeByCode(pool, petitionCode);
      if (!pet) {
        throw new Error(
          "For petition mail list spreadsheets, create an initiative (--upsert-initiative), use --auto-create-initiative with --petition-name and --reporting-geo, create and execute an import plan, or pass --confirm-direct-import."
        );
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  const result = await runFullImport({
    filePath,
    mapPath,
    mapFile,
    petitionCode,
    petitionName,
    projectKey,
    sourceLabel: opts.sourceLabel ?? null,
    createdBy: opts.createdBy ?? null,
    chunkSize,
    autoCreateInitiative: opts.autoCreateInitiative === true,
    initiativeScope: opts.initiativeScope?.trim() ?? null,
    reportingGeo: opts.reportingGeo?.trim() ?? null,
    targetSignatureCount:
      opts.targetSignatureCount != null && Number.isFinite(opts.targetSignatureCount)
        ? opts.targetSignatureCount
        : null,
    initiativeNotes: opts.initiativeNotes?.trim() ?? null,
  });

  console.log(
    JSON.stringify(
      {
        batch_id: result.batch_id,
        petition_code: result.petition_code,
        total_rows: result.total_rows,
        matched: result.matched,
        not_found: result.not_found,
        multiple_matches: result.multiple_matches,
        weak_matches: result.weak_matches,
        errors: result.errors,
        match_rate: result.match_rate,
        permanent_signatures_created_or_updated: result.permanent_signatures_created_or_updated,
        report_dir: result.report_dir,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
