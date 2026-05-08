import { mkdir, access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { insertImportMatchReview, insertSignatureEvent } from "./audit.js";
import type { CanonicalColumnMap, NormalizedRowJson, RawRowJson } from "./types.js";
import {
  assertVoterExistsInMatchSourceOrCanonical,
  fetchVoterGeoForVoterId,
  readMatchSourceTableEnv,
} from "./matchSource.js";
import type { JurisdictionPetitionContext } from "./jurisdiction.js";
import { isSlamDunkMatch, rowNeedsOperatorQueue, rowNeedsReviewByOutcome } from "./matchQuality.js";
import { manualApprovalConfidencePct } from "./confidence.js";
import { loadBatchSignatureReportRows } from "./reporting.js";
import { upsertPetitionSignature } from "./petitions.js";
import { toTitleCaseFromLower } from "./normalize.js";
import type { RankedCandidate } from "./candidateRanking.js";
import {
  buildRankedReviewCandidates,
  fetchNextInitiativeReviewQueue80,
  fetchSnapshotsForRowPage,
  jurisdictionContextFromQueueRow,
  replaceReviewCandidateSnapshots,
  type InitiativeReviewQueue80Row,
} from "./reviewQueue80.js";
import { fetchNonvoterEntriesForPetition, insertInitiativeNonvoterEntry, type NonvoterReportRow } from "./nonvoters.js";
import { escapeCsvCell } from "./reports.js";

const DEFAULT_REVIEW_QUEUE_STATUSES = ["MULTIPLE_MATCHES", "WEAK_MATCH", "NOT_FOUND", "ERROR"] as const;

export type ReviewQueueRow = {
  import_batch_id: string;
  import_row_id: string;
  import_voter_match_id: string;
  row_number: number;
  chunk_number: number;
  project_key: string;
  petition_id: string | null;
  petition_code: string | null;
  file_name: string;
  match_status: string;
  review_status: string;
  candidate_count: number;
  candidate_voter_ids: unknown;
  normalized_json: NormalizedRowJson;
  raw_json: RawRowJson;
  notes: string | null;
  created_at: string;
};

export type BatchSummaryJson = {
  batch_id: string;
  file_name: string | null;
  project_key: string | null;
  petition_code: string | null;
  petition_id: string | null;
  total_rows: number | null;
  batch_status: string | null;
  created_at: string | null;
  completed_at: string | null;
  match_status_counts: Record<string, number>;
  review_status_counts: Record<string, number>;
  permanent_signatures_attached_count: number;
  reports_directory: string | null;
  review_queue_count: number | null;
  approved_count: number | null;
  rejected_count: number | null;
  needs_more_info_count: number | null;
  manually_attached_count: number | null;
  migration_002_applied: boolean;
};

function parseCsvStatuses(raw: string | undefined, fallback: readonly string[]): string[] {
  const s = raw?.trim();
  if (!s) return [...fallback];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function columnExists(
  client: Pick<PoolClient, "query">,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const r = await client.query<{ e: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS e`,
    [tableName, columnName]
  );
  return Boolean(r.rows[0]?.e);
}

export async function viewExists(client: Pick<PoolClient, "query">, viewName: string): Promise<boolean> {
  const r = await client.query<{ e: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.views
       WHERE table_schema = 'public' AND table_name = $1
     ) AS e`,
    [viewName]
  );
  return Boolean(r.rows[0]?.e);
}

export async function tableExists(client: Pick<PoolClient, "query">, tableName: string): Promise<boolean> {
  const r = await client.query<{ e: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS e`,
    [tableName]
  );
  return Boolean(r.rows[0]?.e);
}

export async function fetchReviewQueue(
  pool: Pool,
  opts: {
    batchId: string;
    matchStatuses: string[];
    limit: number;
  }
): Promise<ReviewQueueRow[]> {
  const r = await pool.query<ReviewQueueRow>(
    `SELECT
       mr.import_batch_id,
       mr.import_row_id,
       mr.id AS import_voter_match_id,
       ir.row_number,
       ir.chunk_number,
       b.project_key,
       b.petition_id,
       b.petition_code,
       b.file_name,
       mr.match_status,
       mr.review_status,
       mr.candidate_count,
       mr.candidate_voter_ids,
       ir.normalized_json,
       ir.raw_json,
       mr.notes,
       mr.created_at::text AS created_at
     FROM import_voter_matches mr
     INNER JOIN import_rows ir ON ir.id = mr.import_row_id
     INNER JOIN import_batches b ON b.id = mr.import_batch_id
     WHERE mr.import_batch_id = $1::uuid
       AND mr.match_status = ANY($2::text[])
       AND mr.review_status IN ('UNREVIEWED', 'NEEDS_MORE_INFO')
     ORDER BY ir.row_number ASC
     LIMIT $3`,
    [opts.batchId, opts.matchStatuses, opts.limit]
  );
  return r.rows;
}

export async function fetchBatchSummary(pool: Pool, batchId: string): Promise<BatchSummaryJson | null> {
  const batch = await pool.query<{
    id: string;
    file_name: string | null;
    project_key: string | null;
    petition_code: string | null;
    petition_id: string | null;
    total_rows: string | null;
    status: string | null;
    created_at: string | null;
    completed_at: string | null;
  }>(
    `SELECT id, file_name, project_key, petition_code, petition_id,
            total_rows::text, status, created_at::text, completed_at::text
     FROM import_batches WHERE id = $1::uuid`,
    [batchId]
  );
  if (batch.rows.length === 0) return null;

  const b = batch.rows[0]!;
  const migration002 =
    (await tableExists(pool, "import_match_reviews")) &&
    (await columnExists(pool, "import_voter_matches", "review_status"));

  const matchCounts = await pool.query<{ status: string; c: string }>(
    `SELECT match_status::text AS status, COUNT(*)::text AS c
     FROM import_voter_matches WHERE import_batch_id = $1::uuid GROUP BY match_status`,
    [batchId]
  );
  const match_status_counts: Record<string, number> = {};
  for (const row of matchCounts.rows) {
    match_status_counts[row.status] = Number.parseInt(row.c, 10);
  }

  let review_status_counts: Record<string, number> = {};
  let review_queue_count: number | null = null;
  let approved_count: number | null = null;
  let rejected_count: number | null = null;
  let needs_more_info_count: number | null = null;
  let manually_attached_count: number | null = null;

  if (migration002) {
    const rev = await pool.query<{ status: string; c: string }>(
      `SELECT review_status::text AS status, COUNT(*)::text AS c
       FROM import_voter_matches WHERE import_batch_id = $1::uuid GROUP BY review_status`,
      [batchId]
    );
    for (const row of rev.rows) {
      review_status_counts[row.status] = Number.parseInt(row.c, 10);
    }

    const rq = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM import_voter_matches mr
       WHERE mr.import_batch_id = $1::uuid
         AND mr.match_status IN ('MULTIPLE_MATCHES', 'WEAK_MATCH', 'NOT_FOUND', 'ERROR')
         AND mr.review_status IN ('UNREVIEWED', 'NEEDS_MORE_INFO')`,
      [batchId]
    );
    review_queue_count = Number.parseInt(rq.rows[0]?.c ?? "0", 10);

    approved_count = review_status_counts.APPROVED ?? 0;
    rejected_count = review_status_counts.REJECTED ?? 0;
    needs_more_info_count = review_status_counts.NEEDS_MORE_INFO ?? 0;

    const ma = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM import_match_reviews
       WHERE import_batch_id = $1::uuid AND action = 'ATTACH_SIGNATURE'`,
      [batchId]
    );
    manually_attached_count = Number.parseInt(ma.rows[0]?.c ?? "0", 10);
  }

  const sig = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM voter_petition_signatures WHERE import_batch_id = $1::uuid`,
    [batchId]
  );
  const permanent_signatures_attached_count = Number.parseInt(sig.rows[0]?.c ?? "0", 10);

  const reportDir = join(process.cwd(), "tools", "voter-file-matcher", "reports", batchId);
  let reports_directory: string | null = null;
  try {
    await access(reportDir);
    reports_directory = reportDir;
  } catch {
    reports_directory = null;
  }

  return {
    batch_id: b.id,
    file_name: b.file_name,
    project_key: b.project_key,
    petition_code: b.petition_code,
    petition_id: b.petition_id,
    total_rows: b.total_rows != null ? Number.parseInt(b.total_rows, 10) : null,
    batch_status: b.status,
    created_at: b.created_at,
    completed_at: b.completed_at,
    match_status_counts,
    review_status_counts,
    permanent_signatures_attached_count,
    reports_directory,
    review_queue_count,
    approved_count,
    rejected_count,
    needs_more_info_count,
    manually_attached_count,
    migration_002_applied: migration002,
  };
}

function signerFullNameDisplay(normalized: NormalizedRowJson): string | null {
  const fromFull = toTitleCaseFromLower(normalized.full_name ?? null);
  if (fromFull) return fromFull;
  const joined = [normalized.first_name, normalized.last_name].filter(Boolean).join(" ").trim();
  return joined ? toTitleCaseFromLower(joined) : null;
}

async function getLatestMatchForRow(
  client: PoolClient,
  batchId: string,
  rowNumber: number
): Promise<{
  matchId: string;
  importRowId: string;
  matchStatus: string;
  reviewStatus: string;
  previousResolvedVoterId: string | null;
  matchVoterId: string | null;
  candidateCount: number;
  matchMethod: string | null;
  matchConfidence: string | number | null;
  qaFlags: unknown;
  candidatePage: number;
  candidateSearchOffset: number;
} | null> {
  const r = await client.query<{
    match_id: string;
    import_row_id: string;
    match_status: string;
    review_status: string;
    resolved_voter_id: string | null;
    voter_id: string | null;
    candidate_count: string;
    match_method: string | null;
    match_confidence: string | null;
    qa_flags: unknown;
    candidate_page: string | number | null;
    candidate_search_offset: string | number | null;
  }>(
    `SELECT mr.id AS match_id, ir.id AS import_row_id, mr.match_status, mr.review_status, mr.resolved_voter_id, mr.voter_id,
            mr.candidate_count::text, mr.match_method, mr.match_confidence::text,
            COALESCE(ir.normalized_json->'_qa_flags', '[]'::jsonb) AS qa_flags,
            mr.candidate_page::text, mr.candidate_search_offset::text
     FROM import_rows ir
     INNER JOIN import_voter_matches mr ON mr.import_row_id = ir.id
     WHERE ir.import_batch_id = $1::uuid AND ir.row_number = $2
     ORDER BY mr.created_at DESC
     LIMIT 1`,
    [batchId, rowNumber]
  );
  if (r.rows.length === 0) return null;
  const x = r.rows[0]!;
  return {
    matchId: x.match_id,
    importRowId: x.import_row_id,
    matchStatus: x.match_status,
    reviewStatus: x.review_status,
    previousResolvedVoterId: x.resolved_voter_id,
    matchVoterId: x.voter_id,
    candidateCount: Number.parseInt(x.candidate_count, 10),
    matchMethod: x.match_method,
    matchConfidence: x.match_confidence,
    qaFlags: x.qa_flags,
    candidatePage: Number.parseInt(String(x.candidate_page ?? 0), 10) || 0,
    candidateSearchOffset: Number.parseInt(String(x.candidate_search_offset ?? 0), 10) || 0,
  };
}

export async function runApproveRow(
  pool: Pool,
  opts: {
    batchId: string;
    rowNumber: number;
    voterId: string;
    reviewedBy: string;
    note: string;
    canonicalTableQualified: string;
    cols: CanonicalColumnMap;
    /** When true, allows manual attach even for rows that would normally be blocked (e.g. review-candidate selection). */
    operatorOverride?: boolean;
    /** When selecting a review candidate that is outside the initiative jurisdiction, pass true to attach anyway. */
    allowOutOfJurisdictionAttach?: boolean;
    /** Jurisdiction classification for the selected voter (from review_candidate_snapshots or operator). */
    jurisdictionStatusFromSelection?: string | null;
  }
): Promise<{ summary: Record<string, unknown> }> {
  const vid = opts.voterId.trim();
  if (!vid) throw new Error("voter_id is required and cannot be empty.");

  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const batch = await c.query<{
      petition_id: string | null;
      petition_code: string | null;
      project_key: string | null;
      file_name: string | null;
    }>(
      `SELECT petition_id, petition_code, project_key, file_name FROM import_batches WHERE id = $1::uuid FOR UPDATE`,
      [opts.batchId]
    );
    if (batch.rows.length === 0) {
      throw new Error(`import batch not found: ${opts.batchId}`);
    }
    const b = batch.rows[0]!;
    if (!b.petition_id) {
      throw new Error(
        "This import batch has no petition_id. Link the batch to a petition before manual approval (cannot create petition from this command)."
      );
    }

    const row = await c.query<{ id: string; normalized_json: NormalizedRowJson; raw_json: RawRowJson }>(
      `SELECT id, normalized_json, raw_json FROM import_rows
       WHERE import_batch_id = $1::uuid AND row_number = $2`,
      [opts.batchId, opts.rowNumber]
    );
    if (row.rows.length === 0) {
      throw new Error(`import row not found for batch ${opts.batchId} row_number ${opts.rowNumber}`);
    }
    const importRow = row.rows[0]!;

    const matchInfo = await getLatestMatchForRow(c, opts.batchId, opts.rowNumber);
    if (!matchInfo) {
      throw new Error(`No import_voter_matches row for batch ${opts.batchId} row_number ${opts.rowNumber}`);
    }

    if (matchInfo.reviewStatus === "APPROVED" && matchInfo.previousResolvedVoterId === vid) {
      await c.query("COMMIT");
      return {
        summary: {
          ok: true,
          idempotent: true,
          message: "Row already approved with the same voter_id.",
          batch_id: opts.batchId,
          row_number: opts.rowNumber,
          voter_id: vid,
        },
      };
    }
    if (matchInfo.reviewStatus === "APPROVED" && matchInfo.previousResolvedVoterId !== vid) {
      throw new Error(
        "This row is already APPROVED with a different resolved_voter_id. Reject or supersede before approving with another voter_id."
      );
    }

    const slam = isSlamDunkMatch({
      match_status: matchInfo.matchStatus,
      candidate_count: matchInfo.candidateCount,
      voter_id: matchInfo.matchVoterId,
      match_method: matchInfo.matchMethod,
      match_confidence: matchInfo.matchConfidence,
      qa_flags: matchInfo.qaFlags,
    });
    const allowManual =
      opts.operatorOverride === true ||
      ["MULTIPLE_MATCHES", "WEAK_MATCH", "NOT_FOUND", "ERROR"].includes(matchInfo.matchStatus) ||
      (matchInfo.matchStatus === "MATCHED" && (!slam || matchInfo.reviewStatus === "NEEDS_MORE_INFO"));
    if (!allowManual) {
      throw new Error(
        `Manual approve is not allowed for this row (match_status=${matchInfo.matchStatus}, slam_dunk=${slam}, review_status=${matchInfo.reviewStatus}).`
      );
    }

    await assertVoterExistsInMatchSourceOrCanonical(c, {
      voterId: vid,
      canonicalTableQualified: opts.canonicalTableQualified,
      cols: opts.cols,
    });

    const jSel = (opts.jurisdictionStatusFromSelection ?? "").trim();
    if (jSel === "OUT_OF_JURISDICTION" && opts.allowOutOfJurisdictionAttach !== true) {
      const noteOut =
        opts.note?.trim() ||
        "Selected voter is outside the initiative jurisdiction; no signature attached.";
      await c.query(
        `UPDATE import_voter_matches
         SET review_status = 'NEEDS_MORE_INFO',
             reviewed_at = now(),
             reviewed_by = $2,
             resolution_note = $3,
             jurisdiction_status = 'OUT_OF_JURISDICTION',
             metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
         WHERE id = $1::uuid`,
        [
          matchInfo.matchId,
          opts.reviewedBy,
          noteOut,
          JSON.stringify({ out_of_jurisdiction_review: true, attempted_voter_id: vid }),
        ]
      );
      await insertImportMatchReview(c, {
        importBatchId: opts.batchId,
        importRowId: importRow.id,
        importVoterMatchId: matchInfo.matchId,
        action: "MARK_NEEDS_MORE_INFO",
        previousMatchStatus: matchInfo.matchStatus,
        previousReviewStatus: matchInfo.reviewStatus,
        selectedVoterId: vid,
        selectedPetitionId: b.petition_id,
        selectedPetitionCode: b.petition_code,
        reviewedBy: opts.reviewedBy,
        reviewNote: noteOut,
        metadata: { reason: "OUT_OF_JURISDICTION_ATTACH_BLOCKED" },
      });
      await c.query("COMMIT");
      return {
        summary: {
          ok: true,
          blocked: "OUT_OF_JURISDICTION",
          batch_id: opts.batchId,
          row_number: opts.rowNumber,
          voter_id: vid,
          import_voter_match_id: matchInfo.matchId,
          review_status: "NEEDS_MORE_INFO",
        },
      };
    }

    const petitionCode = b.petition_code ?? "";
    if (!petitionCode) {
      throw new Error("import_batches.petition_code is empty; cannot attach signature.");
    }

    const geoTable = readMatchSourceTableEnv()?.trim() || opts.canonicalTableQualified?.trim() || "";
    let voterWard: string | null = null;
    let voterPrecinct: string | null = null;
    let voterDistrict: string | null = null;
    if (geoTable) {
      try {
        const g = await fetchVoterGeoForVoterId(c, { qualifiedTable: geoTable, voterId: vid });
        voterWard = g.voter_ward;
        voterPrecinct = g.voter_precinct;
        voterDistrict = g.voter_district;
      } catch {
        /* optional geo */
      }
    }

    const manualPct = manualApprovalConfidencePct();
    const sigJurisdiction =
      jSel === "OUT_OF_JURISDICTION" && opts.allowOutOfJurisdictionAttach === true
        ? "OUT_OF_JURISDICTION"
        : jSel === "IN_JURISDICTION" || jSel === "UNKNOWN_JURISDICTION" || jSel === "NOT_CHECKED"
          ? jSel
          : "IN_JURISDICTION";
    const { signatureId, existedBefore } = await upsertPetitionSignature(c, {
      voterId: vid,
      petitionId: b.petition_id,
      petitionCode,
      importBatchId: opts.batchId,
      importRowId: importRow.id,
      sourceProjectKey: b.project_key ?? "",
      sourceLabel: null,
      sourceFileName: b.file_name ?? "",
      normalized: importRow.normalized_json,
      raw: importRow.raw_json,
      matchMethod: "MANUAL_REVIEW_APPROVE",
      matchConfidence: null,
      signerFirstName: toTitleCaseFromLower(importRow.normalized_json.first_name ?? null),
      signerLastName: toTitleCaseFromLower(importRow.normalized_json.last_name ?? null),
      signerFullName: signerFullNameDisplay(importRow.normalized_json),
      signerAddress: importRow.normalized_json.address_line_display ?? null,
      signerCity: importRow.normalized_json.city ?? null,
      signerCounty: importRow.normalized_json.county ?? null,
      signerState: importRow.normalized_json.state ?? null,
      signerZip: importRow.normalized_json.zip ?? null,
      signedAt: importRow.normalized_json.signed_at ?? null,
      voterWard,
      voterPrecinct,
      voterDistrict,
      matchConfidencePct: manualPct,
      jurisdictionStatus: sigJurisdiction,
      duplicateStatus: "NOT_DUPLICATE",
    });

    await c.query(
      `UPDATE import_voter_matches
       SET review_status = 'APPROVED',
           reviewed_at = now(),
           reviewed_by = $2,
           resolved_voter_id = $3,
           resolution_note = $4,
           voter_id = COALESCE(voter_id, $3),
           match_confidence_pct = $5,
           jurisdiction_status = COALESCE($7, jurisdiction_status),
           duplicate_status = COALESCE($8, duplicate_status),
           is_in_review_queue = false,
           metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb
       WHERE id = $1::uuid`,
      [
        matchInfo.matchId,
        opts.reviewedBy,
        vid,
        opts.note,
        manualPct,
        JSON.stringify({ manual_resolution: true, manual_match_confidence_pct: manualPct }),
        sigJurisdiction,
        "NOT_DUPLICATE",
      ]
    );

    await insertImportMatchReview(c, {
      importBatchId: opts.batchId,
      importRowId: importRow.id,
      importVoterMatchId: matchInfo.matchId,
      action: "APPROVE_MATCH",
      previousMatchStatus: matchInfo.matchStatus,
      previousReviewStatus: matchInfo.reviewStatus,
      selectedVoterId: vid,
      selectedPetitionId: b.petition_id,
      selectedPetitionCode: petitionCode,
      reviewedBy: opts.reviewedBy,
      reviewNote: opts.note,
      metadata: {},
    });

    await insertImportMatchReview(c, {
      importBatchId: opts.batchId,
      importRowId: importRow.id,
      importVoterMatchId: matchInfo.matchId,
      action: "ATTACH_SIGNATURE",
      previousMatchStatus: matchInfo.matchStatus,
      previousReviewStatus: "APPROVED",
      selectedVoterId: vid,
      selectedPetitionId: b.petition_id,
      selectedPetitionCode: petitionCode,
      reviewedBy: opts.reviewedBy,
      reviewNote: opts.note,
      metadata: { signature_id: signatureId, existed_before: existedBefore },
    });

    await insertSignatureEvent(c, {
      voterPetitionSignatureId: signatureId,
      voterId: vid,
      petitionId: b.petition_id,
      petitionCode,
      importBatchId: opts.batchId,
      importRowId: importRow.id,
      eventType: "MANUAL_ATTACH_FROM_REVIEW",
      actor: opts.reviewedBy,
      eventNote: opts.note,
      metadata: { import_voter_match_id: matchInfo.matchId },
    });

    await c.query("COMMIT");

    return {
      summary: {
        ok: true,
        batch_id: opts.batchId,
        row_number: opts.rowNumber,
        voter_id: vid,
        petition_id: b.petition_id,
        petition_code: petitionCode,
        import_voter_match_id: matchInfo.matchId,
        signature_id: signatureId,
        signature_existed_before_upsert: existedBefore,
      },
    };
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

export async function runRejectRow(
  pool: Pool,
  opts: { batchId: string; rowNumber: number; reviewedBy: string; note: string }
): Promise<{ summary: Record<string, unknown> }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const matchInfo = await getLatestMatchForRow(c, opts.batchId, opts.rowNumber);
    if (!matchInfo) {
      throw new Error(`No import_voter_matches row for batch ${opts.batchId} row_number ${opts.rowNumber}`);
    }

    await c.query(
      `UPDATE import_voter_matches
       SET review_status = 'REJECTED',
           reviewed_at = now(),
           reviewed_by = $2,
           resolution_note = $3
       WHERE id = $1::uuid`,
      [matchInfo.matchId, opts.reviewedBy, opts.note]
    );

    await insertImportMatchReview(c, {
      importBatchId: opts.batchId,
      importRowId: matchInfo.importRowId,
      importVoterMatchId: matchInfo.matchId,
      action: "REJECT_MATCH",
      previousMatchStatus: matchInfo.matchStatus,
      previousReviewStatus: matchInfo.reviewStatus,
      selectedVoterId: null,
      selectedPetitionId: null,
      selectedPetitionCode: null,
      reviewedBy: opts.reviewedBy,
      reviewNote: opts.note,
      metadata: {},
    });

    await c.query("COMMIT");
    return {
      summary: {
        ok: true,
        batch_id: opts.batchId,
        row_number: opts.rowNumber,
        import_voter_match_id: matchInfo.matchId,
        review_status: "REJECTED",
      },
    };
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

export async function runNeedsMoreInfo(
  pool: Pool,
  opts: { batchId: string; rowNumber: number; reviewedBy: string; note: string }
): Promise<{ summary: Record<string, unknown> }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const matchInfo = await getLatestMatchForRow(c, opts.batchId, opts.rowNumber);
    if (!matchInfo) {
      throw new Error(`No import_voter_matches row for batch ${opts.batchId} row_number ${opts.rowNumber}`);
    }

    await c.query(
      `UPDATE import_voter_matches
       SET review_status = 'NEEDS_MORE_INFO',
           reviewed_at = now(),
           reviewed_by = $2,
           resolution_note = $3
       WHERE id = $1::uuid`,
      [matchInfo.matchId, opts.reviewedBy, opts.note]
    );

    await insertImportMatchReview(c, {
      importBatchId: opts.batchId,
      importRowId: matchInfo.importRowId,
      importVoterMatchId: matchInfo.matchId,
      action: "MARK_NEEDS_MORE_INFO",
      previousMatchStatus: matchInfo.matchStatus,
      previousReviewStatus: matchInfo.reviewStatus,
      selectedVoterId: null,
      selectedPetitionId: null,
      selectedPetitionCode: null,
      reviewedBy: opts.reviewedBy,
      reviewNote: opts.note,
      metadata: {},
    });

    await c.query("COMMIT");
    return {
      summary: {
        ok: true,
        batch_id: opts.batchId,
        row_number: opts.rowNumber,
        import_voter_match_id: matchInfo.matchId,
        review_status: "NEEDS_MORE_INFO",
      },
    };
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

export async function runAddReviewNote(
  pool: Pool,
  opts: { batchId: string; rowNumber: number; reviewedBy: string; note: string }
): Promise<{ summary: Record<string, unknown> }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const matchInfo = await getLatestMatchForRow(c, opts.batchId, opts.rowNumber);
    if (!matchInfo) {
      throw new Error(`No import_voter_matches row for batch ${opts.batchId} row_number ${opts.rowNumber}`);
    }

    const batch = await c.query<{ petition_id: string | null; petition_code: string | null }>(
      `SELECT petition_id, petition_code FROM import_batches WHERE id = $1::uuid`,
      [opts.batchId]
    );
    const b = batch.rows[0];

    await insertImportMatchReview(c, {
      importBatchId: opts.batchId,
      importRowId: matchInfo.importRowId,
      importVoterMatchId: matchInfo.matchId,
      action: "ADD_NOTE",
      previousMatchStatus: matchInfo.matchStatus,
      previousReviewStatus: matchInfo.reviewStatus,
      selectedVoterId: null,
      selectedPetitionId: null,
      selectedPetitionCode: null,
      reviewedBy: opts.reviewedBy,
      reviewNote: opts.note,
      metadata: {},
    });

    const voterForSig = matchInfo.previousResolvedVoterId ?? matchInfo.matchVoterId;

    if (b?.petition_id && voterForSig) {
      const sig = await c.query<{ id: string }>(
        `SELECT id FROM voter_petition_signatures
         WHERE voter_id = $1 AND petition_id = $2::uuid LIMIT 1`,
        [voterForSig, b.petition_id]
      );
      if (sig.rows.length > 0) {
        const code = b.petition_code ?? "";
        await insertSignatureEvent(c, {
          voterPetitionSignatureId: sig.rows[0]!.id,
          voterId: voterForSig,
          petitionId: b.petition_id,
          petitionCode: code,
          importBatchId: opts.batchId,
          importRowId: matchInfo.importRowId,
          eventType: "MANUAL_REVIEW_NOTE",
          actor: opts.reviewedBy,
          eventNote: opts.note,
          metadata: { import_voter_match_id: matchInfo.matchId },
        });
      }
    }

    await c.query("COMMIT");
    return {
      summary: {
        ok: true,
        batch_id: opts.batchId,
        row_number: opts.rowNumber,
        import_voter_match_id: matchInfo.matchId,
        signature_event_logged: Boolean(b?.petition_id && voterForSig),
      },
    };
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

export async function exportReviewQueueCsv(
  pool: Pool,
  opts: { batchId: string; matchStatuses: string[]; outPath: string }
): Promise<string> {
  await mkdir(dirname(opts.outPath), { recursive: true });

  const header =
    "row_number,match_status,review_status,candidate_count,candidate_voter_ids,first_name,last_name,full_name,address,city,county,state,zip,notes,raw_json";

  const r = await pool.query<{
    row_number: number;
    match_status: string;
    review_status: string;
    candidate_count: number;
    candidate_voter_ids: unknown;
    normalized_json: NormalizedRowJson;
    notes: string | null;
    raw_json: RawRowJson;
  }>(
    `SELECT ir.row_number, mr.match_status, mr.review_status, mr.candidate_count, mr.candidate_voter_ids,
            ir.normalized_json, mr.notes, ir.raw_json
     FROM import_voter_matches mr
     INNER JOIN import_rows ir ON ir.id = mr.import_row_id
     WHERE mr.import_batch_id = $1::uuid
       AND mr.match_status = ANY($2::text[])
       AND mr.review_status IN ('UNREVIEWED', 'NEEDS_MORE_INFO')
     ORDER BY ir.row_number ASC`,
    [opts.batchId, opts.matchStatuses]
  );

  const lines = [header];
  for (const row of r.rows) {
    const n = row.normalized_json;
    const line = [
      String(row.row_number),
      row.match_status,
      row.review_status,
      String(row.candidate_count),
      JSON.stringify(row.candidate_voter_ids ?? []),
      n.first_name ?? "",
      n.last_name ?? "",
      n.full_name ?? "",
      n.address_line_display ?? n.address ?? "",
      n.city ?? "",
      n.county ?? "",
      n.state ?? "",
      n.zip ?? "",
      row.notes ?? "",
      JSON.stringify(row.raw_json ?? {}),
    ]
      .map((c) => escapeCsvCell(String(c)))
      .join(",");
    lines.push(line);
  }

  await writeFile(opts.outPath, lines.join("\n") + "\n", "utf8");
  return opts.outPath;
}

export async function runReviewNextUnderThreshold(
  pool: Pool,
  opts: {
    batchId: string;
    canonicalTableQualified: string;
    cols: CanonicalColumnMap;
    searchPoolLimit?: number;
  }
): Promise<{
  queue_row: InitiativeReviewQueue80Row | null;
  candidates: RankedCandidate[];
  commands: Record<string, string>;
}> {
  const next = await fetchNextInitiativeReviewQueue80(pool, opts.batchId);
  if (!next) {
    return {
      queue_row: null,
      candidates: [],
      commands: {},
    };
  }
  const petition = jurisdictionContextFromQueueRow(next);
  const ranked = await buildRankedReviewCandidates(pool, {
    batchId: opts.batchId,
    rowNumber: next.row_number,
    normalized: next.normalized_json,
    petition,
    canonicalTableQualified: opts.canonicalTableQualified,
    cols: opts.cols,
    searchPoolLimit: opts.searchPoolLimit ?? 120,
    offset: 0,
    pageSize: 5,
  });
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    await conn.query(
      `UPDATE import_voter_matches
       SET candidate_page = 0, candidate_search_offset = 0
       WHERE id = $1::uuid`,
      [next.import_voter_match_id]
    );
    await replaceReviewCandidateSnapshots(conn, {
      importBatchId: next.import_batch_id,
      importRowId: next.import_row_id,
      importVoterMatchId: next.import_voter_match_id,
      candidatePage: 0,
      ranked,
    });
    await conn.query("COMMIT");
  } catch (e) {
    try {
      await conn.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    conn.release();
  }
  const bid = opts.batchId;
  const rn = next.row_number;
  return {
    queue_row: next,
    candidates: ranked,
    commands: {
      select: `npm run voter-match -- --select-review-candidate --batch-id ${bid} --row-number ${rn} --candidate-number 1 --reviewed-by "Admin" --note "Selected from top 5"`,
      more: `npm run voter-match -- --more-review-candidates --batch-id ${bid} --row-number ${rn}`,
      nonvoter: `npm run voter-match -- --place-nonvoter --batch-id ${bid} --row-number ${rn} --reviewed-by "Admin" --note "No voter found"`,
      skip: `npm run voter-match -- --skip-review-row --batch-id ${bid} --row-number ${rn} --reviewed-by "Admin" --note "Needs more info"`,
      reject: `npm run voter-match -- --reject-review-row --batch-id ${bid} --row-number ${rn} --reviewed-by "Admin" --note "Reject row"`,
    },
  };
}

export async function runMoreReviewCandidates(
  pool: Pool,
  opts: {
    batchId: string;
    rowNumber: number;
    canonicalTableQualified: string;
    cols: CanonicalColumnMap;
    pageSize?: number;
    searchPoolLimit?: number;
  }
): Promise<{ candidate_page: number; candidate_search_offset: number; candidates: RankedCandidate[] }> {
  const pageSize = opts.pageSize != null && opts.pageSize > 0 ? opts.pageSize : 5;
  const conn = await pool.connect();
  let matchId = "";
  let importRowId = "";
  let newPage = 0;
  let newOff = 0;
  let normalized: NormalizedRowJson = {};
  let petition: JurisdictionPetitionContext = {};
  try {
    await conn.query("BEGIN");
    const m = await getLatestMatchForRow(conn, opts.batchId, opts.rowNumber);
    if (!m) throw new Error(`No import_voter_matches row for batch ${opts.batchId} row_number ${opts.rowNumber}`);
    matchId = m.matchId;
    importRowId = m.importRowId;
    newPage = m.candidatePage + 1;
    newOff = m.candidateSearchOffset + pageSize;
    const row = await conn.query<{ normalized_json: NormalizedRowJson }>(
      `SELECT normalized_json FROM import_rows WHERE id = $1::uuid`,
      [importRowId]
    );
    normalized = row.rows[0]?.normalized_json ?? {};
    const b = await conn.query<{ petition_code: string | null }>(
      `SELECT petition_code FROM import_batches WHERE id = $1::uuid`,
      [opts.batchId]
    );
    const petitionCode = b.rows[0]?.petition_code ?? null;
    const pet = await conn.query<{
      initiative_scope: string | null;
      jurisdiction_type: string | null;
      jurisdiction_city: string | null;
      jurisdiction_county: string | null;
      jurisdiction_state: string | null;
    }>(
      `SELECT initiative_scope, jurisdiction_type, jurisdiction_city, jurisdiction_county, jurisdiction_state
       FROM petitions WHERE petition_code = $1`,
      [petitionCode ?? ""]
    );
    const p = pet.rows[0];
    petition = {
      initiative_scope: p?.initiative_scope ?? null,
      jurisdiction_type: p?.jurisdiction_type ?? null,
      jurisdiction_city: p?.jurisdiction_city ?? null,
      jurisdiction_county: p?.jurisdiction_county ?? null,
      jurisdiction_state: p?.jurisdiction_state ?? null,
    };
    await conn.query(
      `UPDATE import_voter_matches
       SET candidate_page = $2, candidate_search_offset = $3
       WHERE id = $1::uuid`,
      [matchId, newPage, newOff]
    );
    await conn.query("COMMIT");
  } catch (e) {
    try {
      await conn.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    conn.release();
  }

  const ranked = await buildRankedReviewCandidates(pool, {
    batchId: opts.batchId,
    rowNumber: opts.rowNumber,
    normalized,
    petition,
    canonicalTableQualified: opts.canonicalTableQualified,
    cols: opts.cols,
    searchPoolLimit: opts.searchPoolLimit ?? 120,
    offset: newOff,
    pageSize,
  });

  const conn2 = await pool.connect();
  try {
    await conn2.query("BEGIN");
    await replaceReviewCandidateSnapshots(conn2, {
      importBatchId: opts.batchId,
      importRowId,
      importVoterMatchId: matchId,
      candidatePage: newPage,
      ranked,
    });
    await conn2.query("COMMIT");
  } catch (e) {
    try {
      await conn2.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    conn2.release();
  }

  return { candidate_page: newPage, candidate_search_offset: newOff, candidates: ranked };
}

export async function runSelectReviewCandidate(
  pool: Pool,
  opts: {
    batchId: string;
    rowNumber: number;
    candidateNumber: number;
    reviewedBy: string;
    note: string;
    canonicalTableQualified: string;
    cols: CanonicalColumnMap;
    allowOutOfJurisdictionAttach?: boolean;
  }
): Promise<{ summary: Record<string, unknown> }> {
  const conn = await pool.connect();
  let voterId = "";
  let jurisdictionStatus: string | null = null;
  try {
    const m = await getLatestMatchForRow(conn, opts.batchId, opts.rowNumber);
    if (!m) throw new Error(`No import_voter_matches row for batch ${opts.batchId} row_number ${opts.rowNumber}`);
    const snaps = await fetchSnapshotsForRowPage(conn, {
      importBatchId: opts.batchId,
      importRowId: m.importRowId,
      candidatePage: m.candidatePage,
    });
    const pick = snaps.find((s) => s.candidate_rank === opts.candidateNumber);
    if (!pick) {
      throw new Error(
        `No review_candidate_snapshots row for candidate_number=${opts.candidateNumber} on candidate_page=${m.candidatePage}. Run --review-next-under-threshold or --more-review-candidates first.`
      );
    }
    voterId = pick.voter_id.trim();
    if (!voterId) throw new Error("Snapshot voter_id is empty.");
    jurisdictionStatus = pick.jurisdiction_status;
  } finally {
    conn.release();
  }
  return runApproveRow(pool, {
    batchId: opts.batchId,
    rowNumber: opts.rowNumber,
    voterId,
    reviewedBy: opts.reviewedBy,
    note: opts.note,
    canonicalTableQualified: opts.canonicalTableQualified,
    cols: opts.cols,
    operatorOverride: true,
    allowOutOfJurisdictionAttach: opts.allowOutOfJurisdictionAttach === true,
    jurisdictionStatusFromSelection: jurisdictionStatus,
  });
}

export async function runPlaceNonvoter(
  pool: Pool,
  opts: {
    batchId: string;
    rowNumber: number;
    reviewedBy: string;
    note: string;
    nonvoterReviewStatus?: "REJECTED" | "NEEDS_MORE_INFO";
  }
): Promise<{ summary: Record<string, unknown> }> {
  const reviewStatus = opts.nonvoterReviewStatus === "NEEDS_MORE_INFO" ? "NEEDS_MORE_INFO" : "REJECTED";
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const batch = await c.query<{
      petition_id: string | null;
      petition_code: string | null;
      file_name: string | null;
    }>(`SELECT petition_id, petition_code, file_name FROM import_batches WHERE id = $1::uuid FOR UPDATE`, [
      opts.batchId,
    ]);
    const b = batch.rows[0];
    if (!b?.petition_id || !b.petition_code) throw new Error("Batch is missing petition_id or petition_code.");

    const row = await c.query<{ id: string; normalized_json: NormalizedRowJson; raw_json: RawRowJson }>(
      `SELECT id, normalized_json, raw_json FROM import_rows
       WHERE import_batch_id = $1::uuid AND row_number = $2`,
      [opts.batchId, opts.rowNumber]
    );
    if (row.rows.length === 0) throw new Error(`import row not found for batch ${opts.batchId} row_number ${opts.rowNumber}`);
    const ir = row.rows[0]!;
    const matchInfo = await getLatestMatchForRow(c, opts.batchId, opts.rowNumber);
    if (!matchInfo) throw new Error(`No import_voter_matches row for batch ${opts.batchId} row_number ${opts.rowNumber}`);

    await insertInitiativeNonvoterEntry(c, {
      petitionId: b.petition_id,
      petitionCode: b.petition_code,
      importBatchId: opts.batchId,
      importRowId: ir.id,
      importVoterMatchId: matchInfo.matchId,
      sourceFileName: b.file_name,
      rowNumber: opts.rowNumber,
      signerFirstName: ir.normalized_json.first_name ?? null,
      signerLastName: ir.normalized_json.last_name ?? null,
      signerFullName: signerFullNameDisplay(ir.normalized_json),
      signerAddress: ir.normalized_json.address_line_display ?? ir.normalized_json.address ?? null,
      signerCity: ir.normalized_json.city ?? null,
      signerCounty: ir.normalized_json.county ?? null,
      signerState: ir.normalized_json.state ?? null,
      signerZip: ir.normalized_json.zip ?? null,
      signedAt: ir.normalized_json.signed_at ?? null,
      reason: "NO_MATCH_FOUND",
      reviewedBy: opts.reviewedBy,
      reviewNote: opts.note,
      rawRowJson: ir.raw_json,
      normalizedJson: ir.normalized_json,
      metadata: { source: "PLACE_NONVOTER" },
    });

    await c.query(
      `UPDATE import_voter_matches
       SET review_status = $2,
           reviewed_at = now(),
           reviewed_by = $3,
           resolution_note = $4
       WHERE id = $1::uuid`,
      [matchInfo.matchId, reviewStatus, opts.reviewedBy, opts.note]
    );

    await insertImportMatchReview(c, {
      importBatchId: opts.batchId,
      importRowId: ir.id,
      importVoterMatchId: matchInfo.matchId,
      action: "PLACE_NONVOTER",
      previousMatchStatus: matchInfo.matchStatus,
      previousReviewStatus: matchInfo.reviewStatus,
      selectedVoterId: null,
      selectedPetitionId: b.petition_id,
      selectedPetitionCode: b.petition_code,
      reviewedBy: opts.reviewedBy,
      reviewNote: opts.note,
      metadata: { review_status: reviewStatus },
    });

    await c.query("COMMIT");
    return {
      summary: {
        ok: true,
        batch_id: opts.batchId,
        row_number: opts.rowNumber,
        import_voter_match_id: matchInfo.matchId,
        review_status: reviewStatus,
        petition_code: b.petition_code,
      },
    };
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

export async function runNonvoterReport(
  pool: Pool,
  opts: { petitionCode: string; outDir?: string }
): Promise<{ out_json: string; out_csv: string; row_count: number }> {
  const conn = await pool.connect();
  let rows: NonvoterReportRow[] = [];
  try {
    rows = await fetchNonvoterEntriesForPetition(conn, opts.petitionCode);
  } finally {
    conn.release();
  }
  const base =
    opts.outDir?.trim() ||
    join(process.cwd(), "tools", "voter-file-matcher", "reports", `nonvoters-${opts.petitionCode.replace(/[^a-zA-Z0-9_-]+/g, "_")}`);
  await mkdir(base, { recursive: true });
  const outJson = join(base, "nonvoter_summary.json");
  const outCsv = join(base, "nonvoter_entries.csv");
  await writeFile(
    outJson,
    JSON.stringify(
      {
        petition_code: opts.petitionCode,
        generated_at: new Date().toISOString(),
        total: rows.length,
      },
      null,
      2
    ),
    "utf8"
  );
  const header = "row_number,first_name,last_name,address,city,state,zip,signed_at,reason,reviewed_by,reviewed_at,note";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        r.row_number == null ? "" : String(r.row_number),
        r.first_name ?? "",
        r.last_name ?? "",
        r.address ?? "",
        r.city ?? "",
        r.state ?? "",
        r.zip ?? "",
        r.signed_at ?? "",
        r.reason,
        r.reviewed_by ?? "",
        r.reviewed_at ?? "",
        r.note ?? "",
      ]
        .map((x) => escapeCsvCell(x))
        .join(",")
    );
  }
  await writeFile(outCsv, lines.join("\n") + "\n", "utf8");
  return { out_json: outJson, out_csv: outCsv, row_count: rows.length };
}

export { parseCsvStatuses, DEFAULT_REVIEW_QUEUE_STATUSES };

function slamFieldsFromDbRow(row: {
  match_status: string;
  candidate_count: string;
  voter_id: string | null;
  match_method: string | null;
  match_confidence: string | null;
  qa_flags: unknown;
}) {
  return {
    match_status: row.match_status,
    candidate_count: row.candidate_count,
    voter_id: row.voter_id,
    match_method: row.match_method,
    match_confidence: row.match_confidence,
    qa_flags: row.qa_flags,
  };
}

export async function runReviewProgress(
  pool: Pool,
  batchId: string
): Promise<{
  total_rows: number;
  slam_dunk_matched: number;
  needs_review_total: number;
  unresolved_review_rows: number;
  manually_approved: number;
  rejected: number;
  needs_more_info: number;
  percent_complete: number;
}> {
  const rows = await loadBatchSignatureReportRows(pool, batchId);
  const total_rows = rows.length;
  let slam_dunk_matched = 0;
  let needs_review_total = 0;
  let manually_approved = 0;
  let rejected = 0;
  let needs_more_info = 0;
  let unresolved_review_rows = 0;
  for (const r of rows) {
    const sf = slamFieldsFromDbRow(r);
    if (isSlamDunkMatch(sf)) slam_dunk_matched += 1;
    if (rowNeedsReviewByOutcome(sf)) needs_review_total += 1;
    if (r.review_status === "APPROVED") manually_approved += 1;
    if (r.review_status === "REJECTED") rejected += 1;
    if (r.review_status === "NEEDS_MORE_INFO") needs_more_info += 1;
    if (rowNeedsOperatorQueue(r.review_status, sf)) unresolved_review_rows += 1;
  }
  const percent_complete = total_rows > 0 ? ((total_rows - unresolved_review_rows) / total_rows) * 100 : 100;
  return {
    total_rows,
    slam_dunk_matched,
    needs_review_total,
    unresolved_review_rows,
    manually_approved,
    rejected,
    needs_more_info,
    percent_complete,
  };
}
