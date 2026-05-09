/**
 * Server-side review helpers for the VoteMatch web operator UI.
 * No secrets in return values; validate UUIDs before calling.
 */
import { resolve } from "node:path";
import type { Pool } from "pg";
import type { CanonicalColumnMap, NormalizedRowJson } from "./types.js";
import { loadHeaderMapFile } from "./headerMap.js";
import { buildCanonicalColumnMap } from "./matcher.js";
import { readMatchSourceTableEnv } from "./matchSource.js";
import {
  getLatestMatchForRow,
  runMoreReviewCandidates,
  runNeedsMoreInfo,
  runPlaceNonvoter,
  runRejectRow,
  runReviewNextUnderThreshold,
  runReviewProgress,
  runSelectReviewCandidate,
} from "./review.js";
import {
  buildRankedReviewCandidates,
  fetchSnapshotsForRowPage,
  initiativeReviewQueue80ViewExists,
  jurisdictionContextFromQueueRow,
  replaceReviewCandidateSnapshots,
  type InitiativeReviewQueue80Row,
} from "./reviewQueue80.js";
import { problemTagsForRow } from "./matchQuality.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

export type WebReviewCanonicalContext =
  | { ok: true; canonicalTableQualified: string; cols: CanonicalColumnMap }
  | { ok: false; error: string };

function resolveMapOrProfilePath(): string {
  const profile = process.env.VFM_SOURCE_PROFILE_PATH?.trim();
  if (profile) return resolve(process.cwd(), profile);
  const map = process.env.VFM_HEADER_MAP_PATH?.trim();
  if (map) return resolve(process.cwd(), map);
  throw new Error("Set VFM_SOURCE_PROFILE_PATH or VFM_HEADER_MAP_PATH.");
}

export async function resolveReviewCanonicalContext(): Promise<WebReviewCanonicalContext> {
  try {
    const mapPath = resolveMapOrProfilePath();
    const mapFile = await loadHeaderMapFile(mapPath);
    const cols = buildCanonicalColumnMap(mapFile);
    const canonicalTableQualified = process.env.VFM_CANONICAL_TABLE?.trim() ?? "";
    if (!canonicalTableQualified && !readMatchSourceTableEnv()?.trim()) {
      return {
        ok: false,
        error: "Set VFM_CANONICAL_TABLE or VFM_MATCH_SOURCE_TABLE for candidate search and manual approval.",
      };
    }
    return { ok: true, canonicalTableQualified, cols };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not load header map / profile." };
  }
}

export function webReviewOperatorLabel(): string {
  return process.env.VFM_REVIEW_OPERATOR_LABEL?.trim() || "web_operator";
}

export type ReviewCandidateUi = {
  candidate_rank: number;
  voter_id: string;
  candidate_score: number;
  candidate_reason: string | null;
  jurisdiction_status: string | null;
  first_name: string | null;
  last_name: string | null;
  birth_year: number | null;
  birth_date: string | null;
  address: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  zip5: string | null;
  ward: string | null;
  precinct: string | null;
};

export async function fetchReviewQueueRow(
  pool: Pool,
  batchId: string,
  rowNumber: number
): Promise<InitiativeReviewQueue80Row | null> {
  if (!isValidUuid(batchId) || !Number.isFinite(rowNumber) || rowNumber < 1) return null;
  const has = await initiativeReviewQueue80ViewExists(pool);
  if (!has) return null;
  const r = await pool.query<InitiativeReviewQueue80Row>(
    `SELECT *
     FROM initiative_review_queue_80
     WHERE import_batch_id = $1::uuid AND row_number = $2
     LIMIT 1`,
    [batchId, rowNumber]
  );
  return r.rows[0] ?? null;
}

export type ReviewQueueTableRowUi = {
  row_number: number;
  match_confidence_pct: number | null;
  match_status: string;
  review_status: string;
  problem_summary: string;
  signer_city: string | null;
  signer_zip: string | null;
  jurisdiction_status: string | null;
  duplicate_status: string | null;
};

function pct(n: unknown): number | null {
  if (n == null || n === "") return null;
  const v = typeof n === "number" ? n : Number.parseFloat(String(n));
  return Number.isFinite(v) ? Math.round(v) : null;
}

export async function fetchReviewQueueTableRows(
  pool: Pool,
  batchId: string,
  limit: number
): Promise<ReviewQueueTableRowUi[]> {
  if (!isValidUuid(batchId)) return [];
  const has = await initiativeReviewQueue80ViewExists(pool);
  if (!has) return [];
  const lim = Math.min(Math.max(limit, 1), 500);
  const r = await pool.query<InitiativeReviewQueue80Row>(
    `SELECT *
     FROM initiative_review_queue_80
     WHERE import_batch_id = $1::uuid
     ORDER BY row_number ASC
     LIMIT $2::int`,
    [batchId, lim]
  );
  return r.rows.map((row) => {
    const tags = problemTagsForRow({
      match_status: row.match_status,
      candidate_count: row.candidate_count,
      voter_id: null,
      match_method: null,
      match_confidence: null,
      match_confidence_pct: row.match_confidence_pct,
      qa_flags: row.qa_flags,
      normalized: row.normalized_json,
      notes: row.match_notes,
    });
    return {
      row_number: row.row_number,
      match_confidence_pct: pct(row.match_confidence_pct),
      match_status: row.match_status,
      review_status: row.review_status,
      problem_summary: tags.slice(0, 4).join(", ") || "—",
      signer_city: row.signer_city,
      signer_zip: row.signer_zip,
      jurisdiction_status: row.jurisdiction_status,
      duplicate_status: row.duplicate_status,
    };
  });
}

export async function fetchCandidatesForRowPageUi(
  pool: Pool,
  batchId: string,
  rowNumber: number
): Promise<ReviewCandidateUi[]> {
  if (!isValidUuid(batchId) || !Number.isFinite(rowNumber) || rowNumber < 1) return [];
  const c = await pool.connect();
  try {
    const m = await getLatestMatchForRow(c, batchId, rowNumber);
    if (!m) return [];
    const snaps = await fetchSnapshotsForRowPage(c, {
      importBatchId: batchId,
      importRowId: m.importRowId,
      candidatePage: m.candidatePage,
    });
    return snaps.map((s) => ({
      candidate_rank: s.candidate_rank,
      voter_id: s.voter_id,
      candidate_score: s.candidate_score,
      candidate_reason: s.candidate_reason,
      jurisdiction_status: s.jurisdiction_status,
      first_name: s.first_name,
      last_name: s.last_name,
      birth_year: s.birth_year,
      birth_date: s.birth_date,
      address: s.address,
      city: s.city,
      county: s.county,
      state: s.state,
      zip5: s.zip5,
      ward: s.ward,
      precinct: s.precinct,
    }));
  } finally {
    c.release();
  }
}

export async function ensureReviewCandidateSnapshotsForRow(
  pool: Pool,
  batchId: string,
  rowNumber: number,
  ctx: { canonicalTableQualified: string; cols: CanonicalColumnMap }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidUuid(batchId) || !Number.isFinite(rowNumber) || rowNumber < 1) {
    return { ok: false, error: "Invalid batch or row." };
  }
  const has = await initiativeReviewQueue80ViewExists(pool);
  if (!has) return { ok: false, error: "Review queue view missing (migration 007)." };
  const conn = await pool.connect();
  try {
    const m = await getLatestMatchForRow(conn, batchId, rowNumber);
    if (!m) return { ok: false, error: "No import voter match for this row." };
    const snaps = await fetchSnapshotsForRowPage(conn, {
      importBatchId: batchId,
      importRowId: m.importRowId,
      candidatePage: m.candidatePage,
    });
    if (snaps.length > 0) return { ok: true };

    const row = await conn.query<{ normalized_json: NormalizedRowJson }>(
      `SELECT normalized_json FROM import_rows WHERE id = $1::uuid`,
      [m.importRowId]
    );
    const normalized = row.rows[0]?.normalized_json ?? {};
    const b = await conn.query<{ petition_code: string | null }>(
      `SELECT petition_code FROM import_batches WHERE id = $1::uuid`,
      [batchId]
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
    const petition = {
      initiative_scope: p?.initiative_scope ?? null,
      jurisdiction_type: p?.jurisdiction_type ?? null,
      jurisdiction_city: p?.jurisdiction_city ?? null,
      jurisdiction_county: p?.jurisdiction_county ?? null,
      jurisdiction_state: p?.jurisdiction_state ?? null,
    };
    const ranked = await buildRankedReviewCandidates(pool, {
      batchId,
      rowNumber,
      normalized,
      petition,
      canonicalTableQualified: ctx.canonicalTableQualified,
      cols: ctx.cols,
      searchPoolLimit: 120,
      offset: m.candidateSearchOffset,
      pageSize: 5,
    });
    await conn.query("BEGIN");
    await replaceReviewCandidateSnapshots(conn, {
      importBatchId: batchId,
      importRowId: m.importRowId,
      importVoterMatchId: m.matchId,
      candidatePage: m.candidatePage,
      ranked,
    });
    await conn.query("COMMIT");
    return { ok: true };
  } catch (e) {
    try {
      await conn.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    return { ok: false, error: e instanceof Error ? e.message : "Failed to build review candidates." };
  } finally {
    conn.release();
  }
}

export async function safeRunReviewProgress(pool: Pool, batchId: string) {
  if (!isValidUuid(batchId)) return null;
  try {
    return await runReviewProgress(pool, batchId);
  } catch {
    return null;
  }
}

export type ReviewLandingBatchUi = {
  import_batch_id: string;
  petition_code: string | null;
  file_name: string | null;
  unresolved: number;
};

export type ReviewLandingInitiativeUi = {
  petition_code: string;
  unresolved: number;
};

export type ReviewLandingCounts = {
  unresolved_total: number;
  under_80: number;
  not_found: number;
  multiple_matches: number;
  weak_matches: number;
  out_of_jurisdiction: number;
  possible_duplicates: number;
  needs_more_info: number;
};

export async function fetchReviewLandingData(pool: Pool): Promise<{
  migration_ok: boolean;
  batches: ReviewLandingBatchUi[];
  initiatives: ReviewLandingInitiativeUi[];
  counts: ReviewLandingCounts;
}> {
  const has = await initiativeReviewQueue80ViewExists(pool);
  if (!has) {
    return {
      migration_ok: false,
      batches: [],
      initiatives: [],
      counts: {
        unresolved_total: 0,
        under_80: 0,
        not_found: 0,
        multiple_matches: 0,
        weak_matches: 0,
        out_of_jurisdiction: 0,
        possible_duplicates: 0,
        needs_more_info: 0,
      },
    };
  }

  const batches = await pool.query<{
    import_batch_id: string;
    petition_code: string | null;
    file_name: string | null;
    c: string;
  }>(
    `SELECT q.import_batch_id::text,
            q.petition_code,
            b.file_name,
            COUNT(*)::text AS c
     FROM initiative_review_queue_80 q
     INNER JOIN import_batches b ON b.id = q.import_batch_id
     GROUP BY q.import_batch_id, q.petition_code, b.file_name
     ORDER BY COUNT(*) DESC, q.import_batch_id
     LIMIT 100`
  );

  const initiatives = await pool.query<{ petition_code: string; c: string }>(
    `SELECT petition_code, COUNT(*)::text AS c
     FROM initiative_review_queue_80
     GROUP BY petition_code
     ORDER BY COUNT(*) DESC
     LIMIT 100`
  );

  const statusAgg = await pool.query<{ match_status: string; c: string }>(
    `SELECT match_status::text, COUNT(*)::text AS c
     FROM initiative_review_queue_80
     GROUP BY match_status`
  );
  const byStatus = new Map<string, number>();
  for (const row of statusAgg.rows) {
    byStatus.set(row.match_status, Number.parseInt(row.c, 10) || 0);
  }

  const ooj = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM initiative_review_queue_80 WHERE jurisdiction_status = 'OUT_OF_JURISDICTION'`
  );
  const dup = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM initiative_review_queue_80
     WHERE duplicate_status IN ('POSSIBLE_DUPLICATE','DUPLICATE_WITHIN_FILE','DUPLICATE_EXISTING_SIGNATURE')`
  );
  const nmi = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM initiative_review_queue_80 WHERE review_status = 'NEEDS_MORE_INFO'`
  );
  const under = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM initiative_review_queue_80
     WHERE match_confidence_pct IS NOT NULL AND match_confidence_pct::numeric < 80`
  );
  const total = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM initiative_review_queue_80`
  );

  return {
    migration_ok: true,
    batches: batches.rows.map((r) => ({
      import_batch_id: r.import_batch_id,
      petition_code: r.petition_code,
      file_name: r.file_name,
      unresolved: Number.parseInt(r.c, 10) || 0,
    })),
    initiatives: initiatives.rows.map((r) => ({
      petition_code: r.petition_code ?? "",
      unresolved: Number.parseInt(r.c, 10) || 0,
    })),
    counts: {
      unresolved_total: Number.parseInt(total.rows[0]?.c ?? "0", 10) || 0,
      under_80: Number.parseInt(under.rows[0]?.c ?? "0", 10) || 0,
      not_found: byStatus.get("NOT_FOUND") ?? 0,
      multiple_matches: byStatus.get("MULTIPLE_MATCHES") ?? 0,
      weak_matches: byStatus.get("WEAK_MATCH") ?? 0,
      out_of_jurisdiction: Number.parseInt(ooj.rows[0]?.c ?? "0", 10) || 0,
      possible_duplicates: Number.parseInt(dup.rows[0]?.c ?? "0", 10) || 0,
      needs_more_info: Number.parseInt(nmi.rows[0]?.c ?? "0", 10) || 0,
    },
  };
}

export async function webRunSelectReviewCandidate(
  pool: Pool,
  opts: {
    batchId: string;
    rowNumber: number;
    candidateNumber: number;
    note: string;
    allowOutOfJurisdictionAttach?: boolean;
  },
  ctx: { canonicalTableQualified: string; cols: CanonicalColumnMap }
) {
  return runSelectReviewCandidate(pool, {
    batchId: opts.batchId,
    rowNumber: opts.rowNumber,
    candidateNumber: opts.candidateNumber,
    reviewedBy: webReviewOperatorLabel(),
    note: opts.note,
    canonicalTableQualified: ctx.canonicalTableQualified,
    cols: ctx.cols,
    allowOutOfJurisdictionAttach: opts.allowOutOfJurisdictionAttach === true,
  });
}

export async function webRunMoreReviewCandidates(
  pool: Pool,
  opts: { batchId: string; rowNumber: number },
  ctx: { canonicalTableQualified: string; cols: CanonicalColumnMap }
) {
  return runMoreReviewCandidates(pool, {
    batchId: opts.batchId,
    rowNumber: opts.rowNumber,
    canonicalTableQualified: ctx.canonicalTableQualified,
    cols: ctx.cols,
    pageSize: 5,
  });
}

export async function webRunReviewNext(
  pool: Pool,
  batchId: string,
  ctx: { canonicalTableQualified: string; cols: CanonicalColumnMap }
) {
  return runReviewNextUnderThreshold(pool, {
    batchId,
    canonicalTableQualified: ctx.canonicalTableQualified,
    cols: ctx.cols,
  });
}

export async function webRunPlaceNonvoter(
  pool: Pool,
  opts: { batchId: string; rowNumber: number; note: string },
  nonvoterReviewStatus?: "REJECTED" | "NEEDS_MORE_INFO"
) {
  return runPlaceNonvoter(pool, {
    batchId: opts.batchId,
    rowNumber: opts.rowNumber,
    reviewedBy: webReviewOperatorLabel(),
    note: opts.note,
    nonvoterReviewStatus,
  });
}

export async function webRunReject(pool: Pool, opts: { batchId: string; rowNumber: number; note: string }) {
  return runRejectRow(pool, {
    batchId: opts.batchId,
    rowNumber: opts.rowNumber,
    reviewedBy: webReviewOperatorLabel(),
    note: opts.note,
  });
}

export async function webRunNeedsMoreInfo(pool: Pool, opts: { batchId: string; rowNumber: number; note: string }) {
  return runNeedsMoreInfo(pool, {
    batchId: opts.batchId,
    rowNumber: opts.rowNumber,
    reviewedBy: webReviewOperatorLabel(),
    note: opts.note,
  });
}
