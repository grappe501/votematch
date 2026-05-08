import type { Pool, PoolClient } from "pg";
import type { NormalizedRowJson } from "./types.js";
import type { RankedCandidate } from "./candidateRanking.js";
import { rankCandidatesForRow } from "./candidateRanking.js";
import type { JurisdictionPetitionContext } from "./jurisdiction.js";
import { searchVotersForRow } from "./reviewSearch.js";
import type { CanonicalColumnMap } from "./types.js";

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

export type InitiativeReviewQueue80Row = {
  petition_code: string | null;
  petition_name: string | null;
  initiative_scope: string | null;
  jurisdiction_name: string | null;
  jurisdiction_city: string | null;
  jurisdiction_county: string | null;
  jurisdiction_state: string | null;
  jurisdiction_type: string | null;
  review_confidence_threshold: number | string | null;
  import_batch_id: string;
  import_row_id: string;
  row_number: number;
  chunk_number: number;
  normalized_json: NormalizedRowJson;
  raw_json: Record<string, unknown>;
  import_voter_match_id: string;
  match_status: string;
  match_confidence_pct: number | string | null;
  review_status: string;
  jurisdiction_status: string | null;
  duplicate_status: string | null;
  candidate_count: number | string | null;
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
  match_notes: string | null;
  candidate_page: number | string | null;
  candidate_search_offset: number | string | null;
};

export async function initiativeReviewQueue80ViewExists(pool: Pool): Promise<boolean> {
  return pgViewExists(pool, "initiative_review_queue_80");
}

export async function fetchNextInitiativeReviewQueue80(
  pool: Pool,
  batchId: string
): Promise<InitiativeReviewQueue80Row | null> {
  const has = await initiativeReviewQueue80ViewExists(pool);
  if (!has) {
    throw new Error(
      "View initiative_review_queue_80 is missing. Apply tools/voter-file-matcher/migrations/007_review_candidates_jurisdiction_nonvoters.sql."
    );
  }
  const r = await pool.query<InitiativeReviewQueue80Row>(
    `SELECT *
     FROM initiative_review_queue_80
     WHERE import_batch_id = $1::uuid
     ORDER BY row_number ASC
     LIMIT 1`,
    [batchId]
  );
  return r.rows[0] ?? null;
}

/** Jurisdiction inputs for ranking from a review-queue row (view includes initiative_scope). */
export function jurisdictionContextFromQueueRow(row: InitiativeReviewQueue80Row): JurisdictionPetitionContext {
  return {
    initiative_scope: row.initiative_scope,
    jurisdiction_type: row.jurisdiction_type,
    jurisdiction_city: row.jurisdiction_city,
    jurisdiction_county: row.jurisdiction_county,
    jurisdiction_state: row.jurisdiction_state,
  };
}

export async function buildRankedReviewCandidates(
  pool: Pool,
  opts: {
    batchId: string;
    rowNumber: number;
    normalized: NormalizedRowJson;
    petition: JurisdictionPetitionContext;
    canonicalTableQualified: string;
    cols: CanonicalColumnMap;
    searchPoolLimit: number;
    offset: number;
    pageSize: number;
  }
): Promise<RankedCandidate[]> {
  const { candidates } = await searchVotersForRow(pool, {
    batchId: opts.batchId,
    rowNumber: opts.rowNumber,
    limit: opts.searchPoolLimit,
    canonicalTableQualified: opts.canonicalTableQualified,
    cols: opts.cols,
  });
  const ranked = rankCandidatesForRow(opts.normalized, candidates, opts.petition);
  return ranked.slice(opts.offset, opts.offset + opts.pageSize);
}

export async function replaceReviewCandidateSnapshots(
  client: PoolClient,
  opts: {
    importBatchId: string;
    importRowId: string;
    importVoterMatchId: string | null;
    candidatePage: number;
    ranked: RankedCandidate[];
  }
): Promise<void> {
  await client.query(
    `DELETE FROM review_candidate_snapshots
     WHERE import_batch_id = $1::uuid AND import_row_id = $2::uuid AND candidate_page = $3`,
    [opts.importBatchId, opts.importRowId, opts.candidatePage]
  );
  let nextRank = 1;
  for (const c of opts.ranked) {
    const byNum = c.birth_year ? Number.parseInt(String(c.birth_year), 10) : null;
    const by = byNum != null && Number.isFinite(byNum) ? byNum : null;
    let bd: string | null = (c.birth_date ?? "").trim() || null;
    if (bd && bd.length >= 10) bd = bd.slice(0, 10);
    const bdSql = bd && /^\d{4}-\d{2}-\d{2}$/.test(bd) ? bd : null;
    await client.query(
      `INSERT INTO review_candidate_snapshots (
        import_batch_id, import_row_id, import_voter_match_id,
        candidate_rank, candidate_page, voter_id, candidate_score, candidate_reason,
        first_name, last_name, birth_year, birth_date, address, city, county, state, zip5, ward, precinct,
        jurisdiction_status, metadata
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid,
        $4, $5, $6, $7, $8,
        $9, $10, $11, $12::date, $13, $14, $15, $16, $17, $18, $19,
        $20, $21::jsonb
      )`,
      [
        opts.importBatchId,
        opts.importRowId,
        opts.importVoterMatchId,
        nextRank,
        opts.candidatePage,
        c.voter_id,
        c.candidate_score,
        c.candidate_reason,
        c.first_name || null,
        c.last_name || null,
        by,
        bdSql,
        c.address || null,
        c.city || null,
        c.county || null,
        c.state || null,
        c.zip5 || null,
        c.ward || null,
        c.precinct || null,
        c.jurisdiction_status,
        JSON.stringify({ source: "review_queue_80" }),
      ]
    );
    nextRank += 1;
  }
}

export async function fetchSnapshotsForRowPage(
  client: Pick<PoolClient, "query">,
  opts: { importBatchId: string; importRowId: string; candidatePage: number }
): Promise<
  {
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
  }[]
> {
  const r = await client.query(
    `SELECT candidate_rank, voter_id, candidate_score, candidate_reason, jurisdiction_status,
            first_name, last_name, birth_year, birth_date::text AS birth_date,
            address, city, county, state, zip5, ward, precinct
     FROM review_candidate_snapshots
     WHERE import_batch_id = $1::uuid AND import_row_id = $2::uuid AND candidate_page = $3
     ORDER BY candidate_rank ASC`,
    [opts.importBatchId, opts.importRowId, opts.candidatePage]
  );
  return r.rows as {
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
  }[];
}

