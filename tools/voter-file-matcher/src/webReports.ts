/**
 * Server-side reporting helpers for the VoteMatch Next.js app (aggregate only; no raw voter tables).
 */
import { resolve } from "node:path";
import type { Pool } from "pg";
import { columnExists, viewExists } from "./review.js";
import type { RecentBatchRow } from "./dashboardSnapshots.js";

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Petition codes used in DB: letters, digits, underscore, hyphen. */
export const PETITION_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidUuid(s: string): boolean {
  return UUID_REGEX.test(s.trim());
}

export function isValidPetitionCode(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && PETITION_CODE_REGEX.test(t);
}

export type ReportBatchListFilters = {
  petition_code?: string | null;
  status?: string | null;
  needs_review_only?: boolean;
  limit?: number;
};

export type ReportBatchListRow = RecentBatchRow & {
  under_80: number;
  needs_review: number;
  nonvoters: number;
  out_of_jurisdiction: number;
  duplicates: number;
};

async function tableExists(pool: Pool, tableName: string): Promise<boolean> {
  const r = await pool.query<{ e: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS e`,
    [tableName]
  );
  return Boolean(r.rows[0]?.e);
}

/**
 * Paginated batch list for /reports/batches with optional filters (parameterized).
 */
export async function listReportBatches(pool: Pool, filters: ReportBatchListFilters): Promise<{
  rows: ReportBatchListRow[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const petitionFilter = filters.petition_code?.trim() || null;
  const statusFilter = filters.status?.trim() || null;
  if (petitionFilter && !isValidPetitionCode(petitionFilter)) {
    warnings.push("Ignored invalid petition_code filter.");
  }
  const pc = petitionFilter && isValidPetitionCode(petitionFilter) ? petitionFilter : null;
  const st = statusFilter && statusFilter.length <= 64 ? statusFilter : null;

  const hasPct = await columnExists(pool, "import_voter_matches", "match_confidence_pct");
  const hasQueue80 = await viewExists(pool, "initiative_review_queue_80");
  const hasQueueConf = await viewExists(pool, "initiative_review_confidence_queue");
  const hasJurisdictionCol = await columnExists(pool, "import_voter_matches", "jurisdiction_status");
  const hasDupCol = await columnExists(pool, "import_voter_matches", "duplicate_status");
  const hasNonvoterTable = await tableExists(pool, "initiative_nonvoter_entries");

  if (!hasPct) warnings.push("Migration 006 recommended: import_voter_matches.match_confidence_pct for under-80 counts.");
  if (!hasQueue80 && !hasQueueConf) warnings.push("Review queue view missing (migrations 006/007); needs_review counts may be zero.");

  const params: unknown[] = [];
  let i = 1;
  const where: string[] = ["1=1"];
  if (pc) {
    where.push(`b.petition_code = $${i}::text`);
    params.push(pc);
    i += 1;
  }
  if (st) {
    where.push(`b.status = $${i}::text`);
    params.push(st);
    i += 1;
  }
  if (filters.needs_review_only === true) {
    if (hasQueue80) {
      where.push(
        `EXISTS (SELECT 1 FROM initiative_review_queue_80 q WHERE q.import_batch_id = b.id)`
      );
    } else if (hasQueueConf) {
      where.push(
        `EXISTS (SELECT 1 FROM initiative_review_confidence_queue q WHERE q.import_batch_id = b.id)`
      );
    } else {
      warnings.push("needs_review_only filter ignored (no review queue view).");
    }
  }

  params.push(limit);
  const limParam = `$${i}::int`;

  const agg = await pool.query<{
    batch_id: string;
    file_name: string;
    petition_code: string | null;
    project_key: string;
    total_rows: string;
    matched: string;
    not_found: string;
    multiple_matches: string;
    weak_matches: string;
    errors: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  }>(
    `SELECT b.id::text AS batch_id,
            b.file_name,
            b.petition_code,
            b.project_key,
            b.total_rows::text,
            COUNT(m.id) FILTER (WHERE m.match_status = 'MATCHED')::text AS matched,
            COUNT(m.id) FILTER (WHERE m.match_status = 'NOT_FOUND')::text AS not_found,
            COUNT(m.id) FILTER (WHERE m.match_status = 'MULTIPLE_MATCHES')::text AS multiple_matches,
            COUNT(m.id) FILTER (WHERE m.match_status = 'WEAK_MATCH')::text AS weak_matches,
            COUNT(m.id) FILTER (WHERE m.match_status = 'ERROR')::text AS errors,
            b.status,
            b.created_at::text AS created_at,
            b.completed_at::text AS completed_at
     FROM import_batches b
     LEFT JOIN import_voter_matches m ON m.import_batch_id = b.id
     WHERE ${where.join(" AND ")}
     GROUP BY b.id
     ORDER BY b.created_at DESC
     LIMIT ${limParam}`,
    params
  );

  const batchIds = agg.rows.map((r) => r.batch_id);
  const underMap = new Map<string, number>();
  const reviewMap = new Map<string, number>();
  const nvMap = new Map<string, number>();
  const oojMap = new Map<string, number>();
  const dupMap = new Map<string, number>();

  if (batchIds.length > 0 && hasPct) {
    const u = await pool.query<{ id: string; c: string }>(
      `SELECT mr.import_batch_id::text AS id, COUNT(*)::text AS c
       FROM import_voter_matches mr
       WHERE mr.import_batch_id = ANY($1::uuid[])
         AND mr.match_confidence_pct IS NOT NULL
         AND mr.match_confidence_pct < 80
       GROUP BY mr.import_batch_id`,
      [batchIds]
    );
    for (const row of u.rows) underMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  }

  if (batchIds.length > 0 && hasQueue80) {
    const rv = await pool.query<{ id: string; c: string }>(
      `SELECT q.import_batch_id::text AS id, COUNT(*)::text AS c
       FROM initiative_review_queue_80 q
       WHERE q.import_batch_id = ANY($1::uuid[])
       GROUP BY q.import_batch_id`,
      [batchIds]
    );
    for (const row of rv.rows) reviewMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  } else if (batchIds.length > 0 && hasQueueConf) {
    const rv = await pool.query<{ id: string; c: string }>(
      `SELECT q.import_batch_id::text AS id, COUNT(*)::text AS c
       FROM initiative_review_confidence_queue q
       WHERE q.import_batch_id = ANY($1::uuid[])
       GROUP BY q.import_batch_id`,
      [batchIds]
    );
    for (const row of rv.rows) reviewMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  }

  if (batchIds.length > 0 && hasNonvoterTable) {
    const nv = await pool.query<{ id: string; c: string }>(
      `SELECT e.import_batch_id::text AS id, COUNT(*)::text AS c
       FROM initiative_nonvoter_entries e
       WHERE e.import_batch_id = ANY($1::uuid[])
       GROUP BY e.import_batch_id`,
      [batchIds]
    );
    for (const row of nv.rows) nvMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  }

  if (batchIds.length > 0 && hasJurisdictionCol) {
    const oj = await pool.query<{ id: string; c: string }>(
      `SELECT mr.import_batch_id::text AS id, COUNT(*)::text AS c
       FROM import_voter_matches mr
       WHERE mr.import_batch_id = ANY($1::uuid[])
         AND mr.jurisdiction_status = 'OUT_OF_JURISDICTION'
       GROUP BY mr.import_batch_id`,
      [batchIds]
    );
    for (const row of oj.rows) oojMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  }

  if (batchIds.length > 0 && hasDupCol) {
    const dp = await pool.query<{ id: string; c: string }>(
      `SELECT mr.import_batch_id::text AS id, COUNT(*)::text AS c
       FROM import_voter_matches mr
       WHERE mr.import_batch_id = ANY($1::uuid[])
         AND mr.duplicate_status IN ('POSSIBLE_DUPLICATE','DUPLICATE_WITHIN_FILE','DUPLICATE_EXISTING_SIGNATURE')
       GROUP BY mr.import_batch_id`,
      [batchIds]
    );
    for (const row of dp.rows) dupMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  }

  const rows: ReportBatchListRow[] = agg.rows.map((b) => ({
    batch_id: b.batch_id,
    file_name: b.file_name,
    petition_code: b.petition_code,
    project_key: b.project_key,
    total_rows: b.total_rows != null ? Number.parseInt(b.total_rows, 10) || 0 : 0,
    matched: Number.parseInt(b.matched, 10) || 0,
    not_found: Number.parseInt(b.not_found, 10) || 0,
    multiple_matches: Number.parseInt(b.multiple_matches, 10) || 0,
    weak_matches: Number.parseInt(b.weak_matches, 10) || 0,
    errors: Number.parseInt(b.errors, 10) || 0,
    under_80: underMap.get(b.batch_id) ?? 0,
    needs_review: reviewMap.get(b.batch_id) ?? 0,
    nonvoters: nvMap.get(b.batch_id) ?? 0,
    out_of_jurisdiction: oojMap.get(b.batch_id) ?? 0,
    duplicates: dupMap.get(b.batch_id) ?? 0,
    status: b.status,
    created_at: b.created_at,
    completed_at: b.completed_at,
  }));

  return { rows, warnings };
}

export type InitiativeListRow = {
  petition_code: string;
  petition_name: string;
  initiative_scope: string | null;
  reporting_geo: string | null;
  jurisdiction_label: string | null;
  target_signature_count: number | null;
  total_signatures: number;
  valid_in_jurisdiction: number;
  needs_review: number;
  under_80: number;
  nonvoters: number;
  duplicates: number;
  avg_confidence_pct: number | null;
};

export async function listInitiativesForReports(pool: Pool): Promise<{ rows: InitiativeListRow[]; warnings: string[] }> {
  const warnings: string[] = [];
  const hasPct = await columnExists(pool, "import_voter_matches", "match_confidence_pct");
  const hasQueue80 = await viewExists(pool, "initiative_review_queue_80");
  const hasQueueConf = await viewExists(pool, "initiative_review_confidence_queue");
  const hasNonvoter = await tableExists(pool, "initiative_nonvoter_entries");
  const hasDupCol = await columnExists(pool, "import_voter_matches", "duplicate_status");
  const hasSigJurisdiction = await columnExists(pool, "voter_petition_signatures", "jurisdiction_status");
  const hasSigPct = await columnExists(pool, "voter_petition_signatures", "match_confidence_pct");

  const needsJoin = hasQueue80
    ? `COALESCE((SELECT COUNT(*)::bigint FROM initiative_review_queue_80 q WHERE q.petition_code = p.petition_code),0)::text`
    : hasQueueConf
      ? `COALESCE((SELECT COUNT(*)::bigint FROM initiative_review_confidence_queue q WHERE q.petition_code = p.petition_code),0)::text`
      : `'0'::text`;

  const nvExpr = hasNonvoter
    ? `COALESCE((SELECT COUNT(*)::bigint FROM initiative_nonvoter_entries e WHERE e.petition_code = p.petition_code),0)::text`
    : `'0'::text`;

  const dupExpr = hasDupCol
    ? `COALESCE((
         SELECT COUNT(*)::bigint FROM import_voter_matches mr
         INNER JOIN import_batches b ON b.id = mr.import_batch_id
         WHERE b.petition_code = p.petition_code
           AND mr.duplicate_status IN ('POSSIBLE_DUPLICATE','DUPLICATE_WITHIN_FILE','DUPLICATE_EXISTING_SIGNATURE')
       ),0)::text`
    : `'0'::text`;

  const underExpr = hasPct
    ? `COALESCE((
         SELECT COUNT(*)::bigint FROM import_voter_matches mr
         INNER JOIN import_batches b ON b.id = mr.import_batch_id
         WHERE b.petition_code = p.petition_code
           AND mr.match_confidence_pct IS NOT NULL AND mr.match_confidence_pct < 80
       ),0)::text`
    : `'0'::text`;

  const validExpr = hasSigJurisdiction
    ? `COALESCE(COUNT(s.id) FILTER (WHERE COALESCE(s.jurisdiction_status, 'IN_JURISDICTION') = 'IN_JURISDICTION'), 0)::text`
    : `COALESCE(COUNT(s.id), 0)::text`;

  const avgExpr = hasSigPct
    ? `ROUND(AVG(s.match_confidence_pct)::numeric, 1)::text`
    : `NULL::text`;

  try {
    const r = await pool.query<{
      petition_code: string;
      petition_name: string;
      initiative_scope: string | null;
      reporting_geo: string | null;
      jurisdiction_city: string | null;
      jurisdiction_county: string | null;
      jurisdiction_state: string | null;
      target_signature_count: string | null;
      total_signatures: string;
      valid_in_jurisdiction: string;
      needs_review: string;
      under_80: string;
      nonvoters: string;
      duplicates: string;
      avg_confidence_pct: string | null;
    }>(
      `SELECT p.petition_code,
              p.petition_name,
              p.initiative_scope,
              p.reporting_geo,
              p.jurisdiction_city,
              p.jurisdiction_county,
              p.jurisdiction_state,
              p.target_signature_count::text,
              COALESCE(COUNT(s.id), 0)::text AS total_signatures,
              ${validExpr} AS valid_in_jurisdiction,
              ${needsJoin} AS needs_review,
              ${underExpr} AS under_80,
              ${nvExpr} AS nonvoters,
              ${dupExpr} AS duplicates,
              ${avgExpr} AS avg_confidence_pct
       FROM petitions p
       LEFT JOIN voter_petition_signatures s ON s.petition_id = p.id
       GROUP BY p.id, p.petition_code, p.petition_name, p.initiative_scope, p.reporting_geo,
                p.jurisdiction_city, p.jurisdiction_county, p.jurisdiction_state, p.target_signature_count
       ORDER BY MAX(p.updated_at) DESC NULLS LAST
       LIMIT 300`
    );
    const rows: InitiativeListRow[] = r.rows.map((x) => {
      const bits = [x.jurisdiction_city, x.jurisdiction_county, x.jurisdiction_state].filter(Boolean);
      return {
        petition_code: x.petition_code,
        petition_name: x.petition_name,
        initiative_scope: x.initiative_scope,
        reporting_geo: x.reporting_geo,
        jurisdiction_label: bits.length ? bits.join(" · ") : null,
        target_signature_count:
          x.target_signature_count != null && x.target_signature_count !== ""
            ? Number.parseInt(x.target_signature_count, 10)
            : null,
        total_signatures: Number.parseInt(x.total_signatures, 10) || 0,
        valid_in_jurisdiction: Number.parseInt(x.valid_in_jurisdiction, 10) || 0,
        needs_review: Number.parseInt(x.needs_review, 10) || 0,
        under_80: Number.parseInt(x.under_80, 10) || 0,
        nonvoters: Number.parseInt(x.nonvoters, 10) || 0,
        duplicates: Number.parseInt(x.duplicates, 10) || 0,
        avg_confidence_pct:
          x.avg_confidence_pct != null && x.avg_confidence_pct !== ""
            ? Number.parseFloat(x.avg_confidence_pct)
            : null,
      };
    });
    return { rows, warnings };
  } catch {
    warnings.push("Could not list initiatives (check migrations).");
    return { rows: [], warnings };
  }
}

export function resolveHeaderMapPathForWeb(): string {
  const profile = process.env.VFM_SOURCE_PROFILE_PATH?.trim();
  if (profile) return resolve(process.cwd(), profile);
  const map = process.env.VFM_HEADER_MAP_PATH?.trim();
  if (map) return resolve(process.cwd(), map);
  throw new Error("Set VFM_SOURCE_PROFILE_PATH or VFM_HEADER_MAP_PATH for reporting paths that need the map.");
}
