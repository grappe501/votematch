import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { chunkArray, chunkNumberForRowIndex } from "./chunker.js";
import { createPool } from "./db.js";
import { insertSignatureEvent, recordSignatureEventFailureOnMatch } from "./audit.js";
import { ensurePetition, upsertPetitionSignature } from "./petitions.js";
import { buildCanonicalColumnMap, matchNormalizedRow } from "./matcher.js";
import { serializeHeaderMapForDb } from "./headerMap.js";
import type { ParseFileOptions } from "./parseFile.js";
import { parseVoterBuffer } from "./parseFile.js";
import {
  aggregateByChunk,
  aggregateCityCounty,
  countMatchStatuses,
  insertSummaryReport,
  tryAppendReviewStatsToSummary,
  writeLocalReportFiles,
} from "./reports.js";
import { applyWithinFileDuplicateFlags, buildQaFlagsCsvRow, processMappedRow, stableDuplicateKey } from "./rowPipeline.js";
import { toTitleCaseFromLower } from "./normalize.js";
import { fetchVoterGeoForVoterId, fetchVoterLocationSnapshot, readMatchSourceTableEnv } from "./matchSource.js";
import { calculateMatchConfidencePct, searchPriorityFromConfidence } from "./confidence.js";
import {
  evaluateJurisdictionStatus,
  evaluateSignerJurisdictionStatus,
  type JurisdictionPetitionContext,
} from "./jurisdiction.js";
import { hasSevereQaForReviewQueue } from "./matchQuality.js";
import { upsertInitiative, validateInitiativeExecutionGuards } from "./initiatives.js";
import type {
  CsvReportRow,
  MatchOutcome,
  NormalizedRowJson,
  ParsedSheet,
  QaFlagsCsvRow,
  SummaryReportJson,
  VoterHeaderMapFile,
} from "./types.js";

function parseFileOptionsFromMap(map: {
  sheetName?: string;
  headerRow?: number;
  dataStartRow?: number;
}): ParseFileOptions {
  const out: ParseFileOptions = {};
  if (map.sheetName?.trim()) out.sheetName = map.sheetName.trim();
  if (map.headerRow != null && map.headerRow > 0) out.headerRow = map.headerRow;
  if (map.dataStartRow != null && map.dataStartRow > 0) out.dataStartRow = map.dataStartRow;
  return out;
}

function outcomeToCsvRow(
  rowNumber: number,
  outcome: MatchOutcome,
  normalized: NormalizedRowJson,
  matchConfidencePct: number | null
): CsvReportRow {
  return {
    row_number: rowNumber,
    match_status: outcome.status,
    voter_id: outcome.voterId ?? "",
    candidate_count: outcome.candidateIds.length,
    match_confidence_pct: matchConfidencePct,
    signer_first_name: toTitleCaseFromLower(normalized.first_name ?? null) ?? "",
    signer_last_name: toTitleCaseFromLower(normalized.last_name ?? null) ?? "",
    signer_city: normalized.city ?? "",
    signer_county: normalized.county ?? "",
    signer_address: normalized.address_line_display ?? "",
    signer_zip: normalized.zip ?? "",
    notes: outcome.notes ?? "",
  };
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

function importRowNeedsInitiativeReviewQueue80(opts: {
  matchStatus: string;
  matchConfidencePct: number | null;
  reviewThreshold: number;
  jurisdictionStatus: string | null;
  duplicateStatus: string;
  normalized: NormalizedRowJson;
}): boolean {
  const pct = opts.matchConfidencePct ?? 0;
  const j = opts.jurisdictionStatus ?? "NOT_CHECKED";
  const d = opts.duplicateStatus;
  return (
    opts.matchStatus !== "MATCHED" ||
    pct < opts.reviewThreshold ||
    j === "OUT_OF_JURISDICTION" ||
    j === "UNKNOWN_JURISDICTION" ||
    j === "NOT_CHECKED" ||
    d === "DUPLICATE_WITHIN_FILE" ||
    d === "DUPLICATE_EXISTING_SIGNATURE" ||
    d === "POSSIBLE_DUPLICATE" ||
    hasSevereQaForReviewQueue(opts.normalized)
  );
}

async function finalizePossibleDuplicateSignerKeys(pool: import("pg").Pool, batchId: string): Promise<void> {
  const r = await pool.query<{
    mid: string;
    normalized_json: NormalizedRowJson;
    voter_id: string | null;
    duplicate_status: string | null;
    review_status: string;
  }>(
    `SELECT mr.id AS mid, ir.normalized_json, mr.voter_id, mr.duplicate_status, mr.review_status::text AS review_status
     FROM import_voter_matches mr
     INNER JOIN import_rows ir ON ir.id = mr.import_row_id
     WHERE mr.import_batch_id = $1::uuid`,
    [batchId]
  );
  type R = (typeof r.rows)[number];
  const groups = new Map<string, R[]>();
  for (const row of r.rows) {
    const k = stableDuplicateKey(row.normalized_json);
    if (!k.replace(/\u001f/g, "")) continue;
    const arr = groups.get(k) ?? [];
    arr.push(row);
    groups.set(k, arr);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const vset = new Set(arr.map((x) => (x.voter_id ?? "").trim() || "__NONE__"));
    if (vset.size <= 1) continue;
    for (const row of arr) {
      if (row.duplicate_status === "DUPLICATE_WITHIN_FILE" || row.duplicate_status === "DUPLICATE_EXISTING_SIGNATURE") {
        continue;
      }
      const open = row.review_status === "UNREVIEWED" || row.review_status === "NEEDS_MORE_INFO";
      await pool.query(
        `UPDATE import_voter_matches
         SET duplicate_status = 'POSSIBLE_DUPLICATE',
             is_in_review_queue = CASE WHEN $2::boolean THEN true ELSE is_in_review_queue END
         WHERE id = $1::uuid`,
        [row.mid, open]
      );
    }
  }
}

async function loadPetitionImportContext(
  pool: import("pg").Pool,
  petitionId: string
): Promise<{ reviewThreshold: number; jurisdictionCtx: JurisdictionPetitionContext }> {
  try {
    const r = await pool.query<{
      initiative_scope: string | null;
      jurisdiction_type: string | null;
      jurisdiction_city: string | null;
      jurisdiction_county: string | null;
      jurisdiction_state: string | null;
      th: string | number | null;
    }>(
      `SELECT initiative_scope, jurisdiction_type, jurisdiction_city, jurisdiction_county, jurisdiction_state,
              COALESCE(review_confidence_threshold, 80) AS th
       FROM petitions WHERE id = $1::uuid`,
      [petitionId]
    );
    const x = r.rows[0];
    const thRaw = x?.th != null ? Number.parseInt(String(x.th), 10) : 80;
    return {
      reviewThreshold: Number.isFinite(thRaw) ? thRaw : 80,
      jurisdictionCtx: {
        initiative_scope: x?.initiative_scope ?? null,
        jurisdiction_type: x?.jurisdiction_type ?? null,
        jurisdiction_city: x?.jurisdiction_city ?? null,
        jurisdiction_county: x?.jurisdiction_county ?? null,
        jurisdiction_state: x?.jurisdiction_state ?? null,
      },
    };
  } catch {
    return { reviewThreshold: 80, jurisdictionCtx: {} };
  }
}

type PreparedRow = {
  row_number: number;
  chunk_number: number;
  raw: Record<string, string>;
  normalized: NormalizedRowJson;
};

export type RunFullImportParams = {
  filePath: string;
  mapPath: string;
  mapFile: VoterHeaderMapFile;
  petitionCode: string;
  petitionName: string;
  projectKey: string;
  sourceLabel: string | null;
  createdBy: string | null;
  chunkSize: number;
  /** When true, upserts initiative (petition) metadata before staging rows. */
  autoCreateInitiative?: boolean;
  initiativeScope?: string | null;
  reportingGeo?: string | null;
  targetSignatureCount?: number | null;
  initiativeNotes?: string | null;
  /** When initiative is CITY without jurisdiction_city/state in DB, import aborts unless true. */
  confirmMissingJurisdiction?: boolean;
};

export type RunFullImportResult = {
  batch_id: string;
  petition_id: string;
  petition_code: string;
  total_rows: number;
  matched: number;
  not_found: number;
  multiple_matches: number;
  weak_matches: number;
  errors: number;
  match_rate: number;
  permanent_signatures_created_or_updated: number;
  report_dir: string;
};

/**
 * Full import pipeline (staging, matching, signatures, reports). Caller supplies env-backed canonical table.
 */
export async function runFullImport(params: RunFullImportParams): Promise<RunFullImportResult> {
  const canonicalTable = process.env.VFM_CANONICAL_TABLE?.trim();
  if (!canonicalTable) {
    throw new Error("VFM_CANONICAL_TABLE is required for import.");
  }

  const {
    filePath,
    mapPath,
    mapFile,
    petitionCode,
    petitionName,
    projectKey,
    sourceLabel,
    createdBy,
    chunkSize,
    autoCreateInitiative,
    initiativeScope,
    reportingGeo,
    targetSignatureCount,
    initiativeNotes,
    confirmMissingJurisdiction,
  } = params;

  const buf = await readFile(filePath);
  const fileHash = createHash("sha256").update(buf).digest("hex");
  const pOpts = parseFileOptionsFromMap(mapFile);
  const sheet: ParsedSheet = parseVoterBuffer(buf, filePath, pOpts);
  const cols = buildCanonicalColumnMap(mapFile);

  const pool = createPool();
  const guard = await validateInitiativeExecutionGuards(pool, {
    petitionCode,
    petitionName,
    autoCreateInitiative: autoCreateInitiative === true,
    initiativeScope: initiativeScope ?? null,
    reportingGeo: reportingGeo ?? null,
    targetSignatureCount: targetSignatureCount ?? null,
    profileName: mapFile.profileName ?? null,
    confirmMissingJurisdiction: confirmMissingJurisdiction === true,
  });
  for (const w of guard.warnings) {
    console.warn(`[voter-match] initiative guard: ${w}`);
  }
  if (!guard.ok) {
    await pool.end().catch(() => undefined);
    throw new Error(guard.errors.join("\n"));
  }

  const matchedCsv: CsvReportRow[] = [];
  const notFoundCsv: CsvReportRow[] = [];
  const multipleCsv: CsvReportRow[] = [];
  const weakCsv: CsvReportRow[] = [];
  const errorsCsv: CsvReportRow[] = [];
  const qaRows: QaFlagsCsvRow[] = [];
  let signaturesUpserted = 0;

  let batchId!: string;
  let petitionId!: string;

  const prepared: PreparedRow[] = [];
  for (let i = 0; i < sheet.rows.length; i++) {
    const cells = sheet.rows[i]!;
    const { raw, normalized } = processMappedRow(mapFile, sheet.headers, cells);
    prepared.push({
      row_number: i,
      chunk_number: chunkNumberForRowIndex(i, chunkSize),
      raw,
      normalized,
    });
  }
  applyWithinFileDuplicateFlags(
    mapFile,
    prepared.map((p) => ({ normalized: p.normalized }))
  );

  try {
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      if (autoCreateInitiative === true) {
        const up = await upsertInitiative(setup, {
          petitionCode,
          petitionName,
          projectKey,
          initiativeScope: initiativeScope ?? null,
          reportingGeo: reportingGeo ?? null,
          targetSignatureCount: targetSignatureCount ?? null,
          notes: initiativeNotes ?? null,
        });
        petitionId = up.petition_id;
      } else {
        petitionId = await ensurePetition(setup, {
          petitionCode,
          petitionName,
          projectKey,
        });
      }

      const br = await setup.query<{ id: string }>(
        `INSERT INTO import_batches (
          project_key, petition_id, petition_code, source_label, file_name, file_hash,
          total_rows, status, created_by, metadata
        ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, 'PROCESSING', $8, $9::jsonb)
        RETURNING id`,
        [
          projectKey,
          petitionId,
          petitionCode,
          sourceLabel,
          basename(filePath),
          fileHash,
          sheet.rows.length,
          createdBy,
          JSON.stringify({
            map_path: mapPath.replace(/\\/g, "/"),
            profile_name: mapFile.profileName ?? null,
            match_source_table: readMatchSourceTableEnv(),
          }),
        ]
      );
      batchId = br.rows[0]!.id;

      const ext = basename(filePath).toLowerCase();
      const mime =
        ext.endsWith(".csv") || ext.endsWith(".txt")
          ? "text/csv"
          : ext.endsWith(".xlsx")
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : ext.endsWith(".xls")
              ? "application/vnd.ms-excel"
              : null;

      await setup.query(
        `INSERT INTO import_files (import_batch_id, file_name, file_hash, mime_type, row_count, metadata)
         VALUES ($1::uuid, $2, $3, $4, $5, '{}'::jsonb)`,
        [batchId, basename(filePath), fileHash, mime, sheet.rows.length]
      );

      await setup.query(
        `INSERT INTO import_header_maps (import_batch_id, project_key, map_name, header_map)
         VALUES ($1::uuid, $2, $3, $4::jsonb)`,
        [batchId, projectKey, basename(mapPath), JSON.stringify(serializeHeaderMapForDb(mapFile))]
      );

      await setup.query("COMMIT");
    } catch (e) {
      try {
        await setup.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      setup.release();
    }

    const rowChunks = chunkArray(prepared, chunkSize);
    const petitionImportContext = await loadPetitionImportContext(pool, petitionId);

    for (const chunk of rowChunks) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const ids: string[] = [];
        for (const row of chunk) {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO import_rows (import_batch_id, row_number, chunk_number, raw_json, normalized_json)
             VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb)
             RETURNING id`,
            [
              batchId,
              row.row_number,
              row.chunk_number,
              JSON.stringify(row.raw),
              JSON.stringify(row.normalized),
            ]
          );
          ids.push(ins.rows[0]!.id);
        }

        for (let i = 0; i < chunk.length; i++) {
          const row = chunk[i]!;
          const importRowId = ids[i]!;
          let outcome: MatchOutcome;
          try {
            outcome = await matchNormalizedRow(c, canonicalTable, cols, row.normalized, mapFile);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            outcome = {
              status: "ERROR",
              matchMethod: null,
              matchConfidence: null,
              voterId: null,
              candidateIds: [],
              notes: msg.slice(0, 4000),
            };
          }
          const matchConfidencePct = calculateMatchConfidencePct({
            status: outcome.status,
            matchMethod: outcome.matchMethod,
            matchConfidence: outcome.matchConfidence,
            candidateCount: outcome.candidateIds.length,
            voterId: outcome.voterId,
            normalized: row.normalized,
          });

          const { reviewThreshold, jurisdictionCtx } = petitionImportContext;
          let duplicateStatus: string = (row.normalized._qa_flags ?? []).includes("POSSIBLE_DUPLICATE_WITHIN_FILE")
            ? "DUPLICATE_WITHIN_FILE"
            : "NOT_DUPLICATE";

          let jurisdictionStatus: string | null =
            outcome.status === "MATCHED" && outcome.voterId
              ? "NOT_CHECKED"
              : evaluateSignerJurisdictionStatus(jurisdictionCtx, row.normalized);

          const geoTable = readMatchSourceTableEnv()?.trim() || canonicalTable;
          if (outcome.status === "MATCHED" && outcome.voterId) {
            try {
              const loc = await fetchVoterLocationSnapshot(c, {
                qualifiedTable: geoTable,
                voterId: outcome.voterId,
              });
              jurisdictionStatus = evaluateJurisdictionStatus(jurisdictionCtx, {
                city: loc.city,
                county: loc.county,
                state: loc.state,
                district: loc.district || loc.ward,
              });
            } catch {
              jurisdictionStatus = evaluateSignerJurisdictionStatus(jurisdictionCtx, row.normalized);
            }
          }

          if (outcome.status === "MATCHED" && outcome.voterId) {
            const ex = await c.query<{ id: string }>(
              `SELECT id FROM voter_petition_signatures WHERE voter_id = $1 AND petition_id = $2::uuid LIMIT 1`,
              [outcome.voterId, petitionId]
            );
            if (ex.rows.length > 0) duplicateStatus = "DUPLICATE_EXISTING_SIGNATURE";
          }

          const isInReviewQueue = importRowNeedsInitiativeReviewQueue80({
            matchStatus: outcome.status,
            matchConfidencePct,
            reviewThreshold,
            jurisdictionStatus,
            duplicateStatus,
            normalized: row.normalized,
          });
          const pr = searchPriorityFromConfidence(matchConfidencePct, outcome.status, row.normalized);
          const reviewPriority =
            pr === "HIGH" ? 10 : pr === "MEDIUM" ? 50 : pr === "LOW" ? 90 : pr === "BLOCKED" ? 99 : null;

          const insMr = await c.query<{ id: string }>(
            `INSERT INTO import_voter_matches (
              import_batch_id, import_row_id, voter_id, match_status, match_confidence, match_method,
              candidate_count, candidate_voter_ids, notes, match_confidence_pct,
              jurisdiction_status, duplicate_status, is_in_review_queue, review_priority,
              candidate_page, candidate_search_offset
            ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, 0, 0)
            RETURNING id`,
            [
              batchId,
              importRowId,
              outcome.voterId,
              outcome.status,
              outcome.matchConfidence,
              outcome.matchMethod,
              outcome.candidateIds.length,
              JSON.stringify(outcome.candidateIds),
              outcome.notes,
              matchConfidencePct,
              jurisdictionStatus,
              duplicateStatus,
              isInReviewQueue,
              reviewPriority,
            ]
          );
          const importVoterMatchId = insMr.rows[0]!.id;

          const csvRow = outcomeToCsvRow(row.row_number, outcome, row.normalized, matchConfidencePct);
          qaRows.push(buildQaFlagsCsvRow(row.row_number, row.normalized, outcome));
          if (outcome.status === "MATCHED") matchedCsv.push(csvRow);
          else if (outcome.status === "NOT_FOUND") notFoundCsv.push(csvRow);
          else if (outcome.status === "MULTIPLE_MATCHES") multipleCsv.push(csvRow);
          else if (outcome.status === "WEAK_MATCH") weakCsv.push(csvRow);
          else errorsCsv.push(csvRow);

          const allowAutoAttach =
            outcome.status === "MATCHED" &&
            Boolean(outcome.voterId) &&
            jurisdictionStatus === "IN_JURISDICTION" &&
            duplicateStatus !== "DUPLICATE_EXISTING_SIGNATURE";

          if (allowAutoAttach) {
            let voterWard: string | null = null;
            let voterPrecinct: string | null = null;
            let voterDistrict: string | null = null;
            try {
              const g = await fetchVoterGeoForVoterId(c, {
                qualifiedTable: geoTable,
                voterId: outcome.voterId!,
              });
              voterWard = g.voter_ward;
              voterPrecinct = g.voter_precinct;
              voterDistrict = g.voter_district;
            } catch {
              /* optional geo */
            }
            const { signatureId, existedBefore } = await upsertPetitionSignature(c, {
              voterId: outcome.voterId!,
              petitionId,
              petitionCode,
              importBatchId: batchId,
              importRowId,
              sourceProjectKey: projectKey,
              sourceLabel,
              sourceFileName: basename(filePath),
              normalized: row.normalized,
              raw: row.raw,
              matchMethod: outcome.matchMethod,
              matchConfidence: outcome.matchConfidence,
              signerFirstName: toTitleCaseFromLower(row.normalized.first_name ?? null),
              signerLastName: toTitleCaseFromLower(row.normalized.last_name ?? null),
              signerFullName: signerFullNameDisplay(row.normalized),
              signerAddress: row.normalized.address_line_display ?? null,
              signerCity: row.normalized.city ?? null,
              signerCounty: row.normalized.county ?? null,
              signerState: row.normalized.state ?? null,
              signerZip: row.normalized.zip ?? null,
              signedAt: row.normalized.signed_at ?? null,
              voterWard,
              voterPrecinct,
              voterDistrict,
              matchConfidencePct,
              jurisdictionStatus: "IN_JURISDICTION",
              duplicateStatus: "NOT_DUPLICATE",
            });
            signaturesUpserted += 1;

            try {
              await insertSignatureEvent(c, {
                voterPetitionSignatureId: signatureId,
                voterId: outcome.voterId!,
                petitionId,
                petitionCode,
                importBatchId: batchId,
                importRowId,
                eventType: existedBefore ? "DUPLICATE_IMPORT_UPDATE" : "AUTO_UPSERT_FROM_IMPORT",
                actor: null,
                eventNote: null,
                metadata: { import_voter_match_id: importVoterMatchId },
              });
            } catch (evErr) {
              const msg = evErr instanceof Error ? evErr.message : String(evErr);
              try {
                await recordSignatureEventFailureOnMatch(c, importVoterMatchId, msg);
              } catch {
                /* ignore */
              }
            }
          }
        }

        await c.query("COMMIT");
      } catch (e) {
        try {
          await c.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        c.release();
      }
    }

    await finalizePossibleDuplicateSignerKeys(pool, batchId);

    await pool.query(
      `UPDATE import_batches SET status = 'COMPLETED', completed_at = now(), total_rows = $2 WHERE id = $1::uuid`,
      [batchId, sheet.rows.length]
    );

    const counts = await countMatchStatuses(pool, batchId);
    const { byCity, byCounty } = await aggregateCityCounty(pool, batchId);
    const byChunk = await aggregateByChunk(pool, batchId);

    const completedAt = new Date().toISOString();
    const createdAtRow = await pool.query<{ c: string }>(
      `SELECT created_at::text AS c FROM import_batches WHERE id = $1::uuid`,
      [batchId]
    );
    const createdAt = createdAtRow.rows[0]?.c ?? completedAt;

    const total = sheet.rows.length;
    const extStats = aggregateSummaryExtensions(prepared);
    const summary: SummaryReportJson = {
      batch_id: batchId,
      petition_id: petitionId,
      petition_code: petitionCode,
      file_name: basename(filePath),
      project_key: projectKey,
      total_rows: total,
      matched: counts.matched,
      not_found: counts.notFound,
      multiple_matches: counts.multiple,
      weak_matches: counts.weak,
      errors: counts.errors,
      match_rate: total === 0 ? 0 : counts.matched / total,
      permanent_signatures_created_or_updated: signaturesUpserted,
      by_city: byCity,
      by_county: byCounty,
      by_chunk: byChunk,
      created_at: createdAt,
      completed_at: completedAt,
      source_profile: mapFile.profileName ?? null,
      ...extStats,
    };

    try {
      const pctAgg = await pool.query<{ avg: string | null }>(
        `SELECT ROUND(AVG(match_confidence_pct)::numeric, 1)::text AS avg
         FROM import_voter_matches WHERE import_batch_id = $1::uuid`,
        [batchId]
      );
      summary.avg_match_confidence_pct =
        pctAgg.rows[0]?.avg != null ? Number.parseFloat(pctAgg.rows[0]!.avg!) : null;

      const dist = await pool.query<{ bucket: string; c: string }>(
        `SELECT
           CASE
             WHEN match_confidence_pct IS NULL THEN 'unknown'
             WHEN match_confidence_pct >= 100 THEN '100'
             WHEN match_confidence_pct >= 90 THEN '90_99'
             WHEN match_confidence_pct >= 75 THEN '75_89'
             WHEN match_confidence_pct >= 50 THEN '50_74'
             WHEN match_confidence_pct >= 1 THEN '1_49'
             ELSE '0'
           END AS bucket,
           COUNT(*)::text AS c
         FROM import_voter_matches
         WHERE import_batch_id = $1::uuid
         GROUP BY 1`,
        [batchId]
      );
      const confidence_distribution: Record<string, number> = {};
      for (const row of dist.rows) {
        confidence_distribution[row.bucket] = Number.parseInt(row.c, 10);
      }
      summary.confidence_distribution = confidence_distribution;
      summary.slam_dunk_100_count = confidence_distribution["100"] ?? 0;
      summary.confidence_90_99_count = confidence_distribution["90_99"] ?? 0;
      summary.confidence_75_89_count = confidence_distribution["75_89"] ?? 0;
      summary.confidence_50_74_count = confidence_distribution["50_74"] ?? 0;
      summary.confidence_1_49_count = confidence_distribution["1_49"] ?? 0;
      summary.confidence_0_count = confidence_distribution["0"] ?? 0;

      const ini = await pool.query<{
        initiative_scope: string | null;
        reporting_geo: string | null;
      }>(`SELECT initiative_scope, reporting_geo FROM petitions WHERE id = $1::uuid`, [petitionId]);
      summary.initiative_scope = ini.rows[0]?.initiative_scope ?? null;
      summary.reporting_geo = ini.rows[0]?.reporting_geo ?? null;
    } catch {
      /* Older DB without migration 006 columns: summary stays without confidence aggregates */
    }

    await tryAppendReviewStatsToSummary(pool, batchId, summary);

    await insertSummaryReport(pool, batchId, summary);
    const reportDir = await writeLocalReportFiles(batchId, {
      summary,
      matched: matchedCsv,
      notFound: notFoundCsv,
      multiple: multipleCsv,
      weak: weakCsv,
      errors: errorsCsv,
      qaFlags: qaRows,
    });

    return {
      batch_id: batchId,
      petition_id: petitionId,
      petition_code: petitionCode,
      total_rows: total,
      matched: counts.matched,
      not_found: counts.notFound,
      multiple_matches: counts.multiple,
      weak_matches: counts.weak,
      errors: counts.errors,
      match_rate: summary.match_rate,
      permanent_signatures_created_or_updated: signaturesUpserted,
      report_dir: reportDir,
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
