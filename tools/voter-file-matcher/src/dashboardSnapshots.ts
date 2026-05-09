import type { Pool } from "pg";
import { columnExists, viewExists, runReviewProgress } from "./review.js";

export type DashboardFilters = {
  org: string | null;
};

export type ConfidenceDistribution = {
  pct_100: number;
  pct_90_99: number;
  pct_80_89: number;
  pct_50_79: number;
  pct_1_49: number;
  pct_0: number;
};

export type DashboardTotals = {
  total_batches: number;
  total_import_rows: number;
  total_signatures: number;
  matched_total: number;
  not_found_total: number;
  multiple_matches_total: number;
  weak_matches_total: number;
  error_total: number;
  under_80_total: number;
  needs_review_total: number;
  out_of_jurisdiction_total: number;
  duplicate_total: number;
  nonvoter_total: number;
  avg_confidence_pct: number | null;
};

export type InitiativeReportRow = {
  petition_code: string;
  petition_name: string;
  initiative_scope: string | null;
  reporting_geo: string | null;
  target_signature_count: number | null;
  total_signatures: number;
  valid_in_jurisdiction_signatures: number;
  needs_review_total: number;
  nonvoter_total: number;
  avg_confidence_pct: number | null;
  latest_signature_at: string | null;
};

export type RecentBatchRow = {
  batch_id: string;
  file_name: string;
  petition_code: string | null;
  project_key: string;
  total_rows: number;
  matched: number;
  not_found: number;
  multiple_matches: number;
  weak_matches: number;
  errors: number;
  under_80: number;
  needs_review: number;
  status: string;
  created_at: string;
  completed_at: string | null;
};

export type ProblemCountRow = {
  problem: string;
  count: number;
};

export type WardCountyRow = {
  petition_code: string;
  ward?: string;
  county?: string;
  total_signatures: number;
  avg_confidence_pct: number | null;
};

export type OcrDashboardRollup = {
  ocr_batches_total: number;
  ocr_rows_needing_review: number;
  ocr_rows_confirmed: number;
  ocr_rows_imported_links: number;
};

export type DashboardRollupResult = {
  generated_at: string;
  database_configured: boolean;
  totals: DashboardTotals;
  initiatives: InitiativeReportRow[];
  recent_batches: RecentBatchRow[];
  confidence_distribution: ConfidenceDistribution;
  problem_counts: ProblemCountRow[];
  ward_counts: WardCountyRow[];
  county_counts: WardCountyRow[];
  warnings: string[];
  /** Present when migration 008 OCR tables exist. */
  ocr_totals: OcrDashboardRollup | null;
};

function orgBatchWhere(paramIdx: number): string {
  return `($${paramIdx}::text IS NULL OR b.project_key = $${paramIdx})`;
}

async function safeCount(
  pool: Pool,
  sql: string,
  params: unknown[],
  fallback: number,
  onFail: (msg: string) => void
): Promise<number> {
  try {
    const r = await pool.query<{ c: string }>(sql, params);
    return Number.parseInt(r.rows[0]?.c ?? "0", 10) || 0;
  } catch {
    onFail("query failed");
    return fallback;
  }
}

export async function fetchOrgKeys(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ k: string }>(
    `SELECT DISTINCT k
     FROM (
       SELECT trim(project_key) AS k FROM import_batches
       UNION
       SELECT trim(project_key) AS k FROM petitions WHERE project_key IS NOT NULL
     ) x
     WHERE k IS NOT NULL AND k <> ''
     ORDER BY 1`
  );
  return r.rows.map((x) => x.k);
}

/** Full aggregate dashboard (no signer PII). */
export async function fetchDashboardRollups(pool: Pool, filters: DashboardFilters): Promise<DashboardRollupResult> {
  const warnings: string[] = [];
  const org = filters.org?.trim() || null;
  const p: unknown[] = [org];
  const ow = orgBatchWhere(1);

  const hasPct = await columnExists(pool, "import_voter_matches", "match_confidence_pct");
  if (!hasPct) warnings.push("Migration needed: import_voter_matches.match_confidence_pct missing (apply 006).");

  const hasJurisdictionCol = await columnExists(pool, "import_voter_matches", "jurisdiction_status");
  if (!hasJurisdictionCol) warnings.push("Migration needed: import_voter_matches.jurisdiction_status missing (apply 007).");

  const hasDupCol = await columnExists(pool, "import_voter_matches", "duplicate_status");
  if (!hasDupCol) warnings.push("Migration needed: import_voter_matches.duplicate_status missing (apply 007).");

  const hasNonvoterTable = await tableExists(pool, "initiative_nonvoter_entries");
  if (!hasNonvoterTable) warnings.push("Migration needed: initiative_nonvoter_entries missing (apply 007).");

  const hasQueue80 = await viewExists(pool, "initiative_review_queue_80");
  const hasQueueConf = await viewExists(pool, "initiative_review_confidence_queue");
  if (!hasQueue80 && !hasQueueConf) {
    warnings.push("Migration needed: review queue view missing (apply 006/007).");
  }

  const hasWardView = await viewExists(pool, "initiative_ward_counts");
  const hasCountyView = await viewExists(pool, "initiative_county_counts");
  if (!hasWardView) warnings.push("Optional: initiative_ward_counts view missing (apply 007).");
  if (!hasCountyView) warnings.push("Optional: initiative_county_counts view missing (apply 007).");

  const total_batches = await safeCount(
    pool,
    `SELECT COUNT(*)::text AS c FROM import_batches b WHERE ${ow}`,
    p,
    0,
    () => warnings.push("Could not count import_batches.")
  );

  const total_import_rows = await safeCount(
    pool,
    `SELECT COUNT(*)::text AS c
     FROM import_rows ir
     INNER JOIN import_batches b ON b.id = ir.import_batch_id
     WHERE ${ow}`,
    p,
    0,
    () => {}
  );

  const baseMr = `FROM import_voter_matches mr INNER JOIN import_batches b ON b.id = mr.import_batch_id WHERE ${ow}`;

  const matched_total = await safeCount(pool, `SELECT COUNT(*)::text AS c ${baseMr} AND mr.match_status = 'MATCHED'`, p, 0, () => {});
  const not_found_total = await safeCount(pool, `SELECT COUNT(*)::text AS c ${baseMr} AND mr.match_status = 'NOT_FOUND'`, p, 0, () => {});
  const multiple_matches_total = await safeCount(
    pool,
    `SELECT COUNT(*)::text AS c ${baseMr} AND mr.match_status = 'MULTIPLE_MATCHES'`,
    p,
    0,
    () => {}
  );
  const weak_matches_total = await safeCount(pool, `SELECT COUNT(*)::text AS c ${baseMr} AND mr.match_status = 'WEAK_MATCH'`, p, 0, () => {});
  const error_total = await safeCount(pool, `SELECT COUNT(*)::text AS c ${baseMr} AND mr.match_status = 'ERROR'`, p, 0, () => {});

  let under_80_total = 0;
  if (hasPct) {
    under_80_total = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c ${baseMr} AND mr.match_confidence_pct IS NOT NULL AND mr.match_confidence_pct < 80`,
      p,
      0,
      () => {}
    );
  }

  let needs_review_total = 0;
  if (hasQueue80) {
    needs_review_total = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c
       FROM initiative_review_queue_80 q
       INNER JOIN import_batches b ON b.id = q.import_batch_id
       WHERE ${ow}`,
      p,
      0,
      () => {}
    );
  } else if (hasQueueConf) {
    needs_review_total = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c
       FROM initiative_review_confidence_queue q
       INNER JOIN import_batches b ON b.id = q.import_batch_id
       WHERE ${ow}`,
      p,
      0,
      () => {}
    );
  }

  let out_of_jurisdiction_total = 0;
  if (hasJurisdictionCol) {
    out_of_jurisdiction_total = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c ${baseMr} AND mr.jurisdiction_status = 'OUT_OF_JURISDICTION'`,
      p,
      0,
      () => {}
    );
  }

  let duplicate_total = 0;
  if (hasDupCol) {
    duplicate_total = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c ${baseMr}
       AND mr.duplicate_status IN ('POSSIBLE_DUPLICATE','DUPLICATE_WITHIN_FILE','DUPLICATE_EXISTING_SIGNATURE')`,
      p,
      0,
      () => {}
    );
  }

  let nonvoter_total = 0;
  if (hasNonvoterTable) {
    nonvoter_total = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c
       FROM initiative_nonvoter_entries e
       INNER JOIN petitions p ON p.id = e.petition_id
       WHERE ($1::text IS NULL OR p.project_key = $1)`,
      p,
      0,
      () => {}
    );
  }

  let avg_confidence_pct: number | null = null;
  if (hasPct) {
    const av = await pool.query<{ a: string | null }>(
      `SELECT ROUND(AVG(mr.match_confidence_pct)::numeric, 1)::text AS a ${baseMr} AND mr.match_confidence_pct IS NOT NULL`,
      p
    );
    avg_confidence_pct =
      av.rows[0]?.a != null && av.rows[0].a !== "" ? Number.parseFloat(av.rows[0].a!) : null;
    if (Number.isNaN(avg_confidence_pct ?? NaN)) avg_confidence_pct = null;
  }

  const totals: DashboardTotals = {
    total_batches,
    total_import_rows,
    total_signatures: total_import_rows,
    matched_total,
    not_found_total,
    multiple_matches_total,
    weak_matches_total,
    error_total,
    under_80_total,
    needs_review_total,
    out_of_jurisdiction_total,
    duplicate_total,
    nonvoter_total,
    avg_confidence_pct,
  };

  let confidence_distribution: ConfidenceDistribution = {
    pct_100: 0,
    pct_90_99: 0,
    pct_80_89: 0,
    pct_50_79: 0,
    pct_1_49: 0,
    pct_0: 0,
  };
  if (hasPct) {
    const dist = await pool.query<{ bucket: string; c: string }>(
      `SELECT
         CASE
           WHEN mr.match_confidence_pct >= 100 THEN 'pct_100'
           WHEN mr.match_confidence_pct >= 90 THEN 'pct_90_99'
           WHEN mr.match_confidence_pct >= 80 THEN 'pct_80_89'
           WHEN mr.match_confidence_pct >= 50 THEN 'pct_50_79'
           WHEN mr.match_confidence_pct >= 1 THEN 'pct_1_49'
           ELSE 'pct_0'
         END AS bucket,
         COUNT(*)::text AS c
       ${baseMr}
       AND mr.match_confidence_pct IS NOT NULL
       GROUP BY 1`,
      p
    );
    for (const row of dist.rows) {
      const n = Number.parseInt(row.c, 10) || 0;
      if (row.bucket === "pct_100") confidence_distribution.pct_100 = n;
      else if (row.bucket === "pct_90_99") confidence_distribution.pct_90_99 = n;
      else if (row.bucket === "pct_80_89") confidence_distribution.pct_80_89 = n;
      else if (row.bucket === "pct_50_79") confidence_distribution.pct_50_79 = n;
      else if (row.bucket === "pct_1_49") confidence_distribution.pct_1_49 = n;
      else if (row.bucket === "pct_0") confidence_distribution.pct_0 = n;
    }
  }

  const problem_counts: ProblemCountRow[] = [
    { problem: "MATCHED", count: matched_total },
    { problem: "NOT_FOUND", count: not_found_total },
    { problem: "MULTIPLE_MATCHES", count: multiple_matches_total },
    { problem: "WEAK_MATCH", count: weak_matches_total },
    { problem: "ERROR", count: error_total },
    { problem: "NEEDS_REVIEW (queue)", count: needs_review_total },
    { problem: "UNDER_80_CONFIDENCE", count: under_80_total },
    { problem: "OUT_OF_JURISDICTION", count: out_of_jurisdiction_total },
    { problem: "DUPLICATE_FLAGS", count: duplicate_total },
    { problem: "NONVOTER_ENTRIES", count: nonvoter_total },
  ].sort((a, b) => b.count - a.count);

  const hasSigPct = await columnExists(pool, "voter_petition_signatures", "match_confidence_pct");
  if (!hasSigPct) warnings.push("Migration needed: voter_petition_signatures.match_confidence_pct missing (apply 006).");
  const hasSigJurisdiction = await columnExists(pool, "voter_petition_signatures", "jurisdiction_status");
  if (!hasSigJurisdiction) {
    warnings.push(
      "Migration needed: voter_petition_signatures.jurisdiction_status missing (apply 007); valid-in-jurisdiction counts may equal total until applied."
    );
  }

  let initiatives: InitiativeReportRow[] = [];
  try {
    const needsJoin = hasQueue80
      ? `COALESCE((
           SELECT COUNT(*)::bigint FROM initiative_review_queue_80 q
           WHERE q.petition_code = p.petition_code
         ),0)::text`
      : hasQueueConf
        ? `COALESCE((
           SELECT COUNT(*)::bigint FROM initiative_review_confidence_queue q
           WHERE q.petition_code = p.petition_code
         ),0)::text`
        : `'0'::text`;

    const nvExpr = hasNonvoterTable
      ? `COALESCE((SELECT COUNT(*)::bigint FROM initiative_nonvoter_entries e WHERE e.petition_code = p.petition_code),0)::text`
      : `'0'::text`;

    const validInJurisdictionExpr = hasSigJurisdiction
      ? `COALESCE(COUNT(s.id) FILTER (
                WHERE COALESCE(s.jurisdiction_status, 'IN_JURISDICTION') = 'IN_JURISDICTION'
              ), 0)::text AS valid_in_jurisdiction_signatures`
      : `COALESCE(COUNT(s.id), 0)::text AS valid_in_jurisdiction_signatures`;

    const avgConfidenceExpr = hasSigPct
      ? `ROUND(AVG(s.match_confidence_pct)::numeric, 1)::text AS avg_confidence_pct`
      : `NULL::text AS avg_confidence_pct`;

    const ij = await pool.query<{
      petition_code: string;
      petition_name: string;
      initiative_scope: string | null;
      reporting_geo: string | null;
      target_signature_count: string | null;
      total_signatures: string;
      valid_in_jurisdiction_signatures: string;
      needs_review_total: string;
      nonvoter_total: string;
      avg_confidence_pct: string | null;
      latest_signature_at: string | null;
    }>(
      `SELECT p.petition_code,
              p.petition_name,
              p.initiative_scope,
              p.reporting_geo,
              p.target_signature_count::text,
              COALESCE(COUNT(s.id), 0)::text AS total_signatures,
              ${validInJurisdictionExpr},
              ${needsJoin} AS needs_review_total,
              ${nvExpr} AS nonvoter_total,
              ${avgConfidenceExpr},
              MAX(s.updated_at)::text AS latest_signature_at
       FROM petitions p
       LEFT JOIN voter_petition_signatures s ON s.petition_id = p.id
       WHERE ($1::text IS NULL OR p.project_key = $1)
       GROUP BY p.id, p.petition_code, p.petition_name, p.initiative_scope, p.reporting_geo, p.target_signature_count
       ORDER BY MAX(p.updated_at) DESC NULLS LAST
       LIMIT 200`,
      p
    );
    initiatives = ij.rows.map((r) => ({
      petition_code: r.petition_code,
      petition_name: r.petition_name,
      initiative_scope: r.initiative_scope,
      reporting_geo: r.reporting_geo,
      target_signature_count: r.target_signature_count != null ? Number.parseInt(r.target_signature_count, 10) : null,
      total_signatures: Number.parseInt(r.total_signatures, 10) || 0,
      valid_in_jurisdiction_signatures: Number.parseInt(r.valid_in_jurisdiction_signatures, 10) || 0,
      needs_review_total: Number.parseInt(r.needs_review_total, 10) || 0,
      nonvoter_total: Number.parseInt(r.nonvoter_total, 10) || 0,
      avg_confidence_pct: r.avg_confidence_pct != null && r.avg_confidence_pct !== "" ? Number.parseFloat(r.avg_confidence_pct) : null,
      latest_signature_at: r.latest_signature_at,
    }));
  } catch {
    warnings.push("Could not load initiative rollup table (check migrations).");
  }

  const batchAgg = await pool.query<{
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
     WHERE ${ow}
     GROUP BY b.id
     ORDER BY b.created_at DESC
     LIMIT 50`,
    p
  );

  const batchIds = batchAgg.rows.map((r) => r.batch_id);
  const underMap = new Map<string, number>();
  const reviewMap = new Map<string, number>();

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

  const recent_batches: RecentBatchRow[] = batchAgg.rows.map((b) => ({
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
    status: b.status,
    created_at: b.created_at,
    completed_at: b.completed_at,
  }));

  const ward_counts: WardCountyRow[] = [];
  if (hasWardView) {
    try {
      const w = await pool.query<{ petition_code: string; ward: string; c: string; a: string | null }>(
        `SELECT w.petition_code,
                w.voter_ward AS ward,
                w.total_signatures::text AS c,
                w.avg_confidence_pct::text AS a
         FROM initiative_ward_counts w
         INNER JOIN petitions p ON p.petition_code = w.petition_code
         WHERE ($1::text IS NULL OR p.project_key = $1)
         ORDER BY w.total_signatures DESC
         LIMIT 120`,
        p
      );
      for (const row of w.rows) {
        ward_counts.push({
          petition_code: row.petition_code,
          ward: row.ward,
          total_signatures: Number.parseInt(row.c, 10) || 0,
          avg_confidence_pct: row.a != null && row.a !== "" ? Number.parseFloat(row.a) : null,
        });
      }
    } catch {
      warnings.push("Could not read initiative_ward_counts.");
    }
  }

  const county_counts: WardCountyRow[] = [];
  let ocr_totals: OcrDashboardRollup | null = null;
  try {
    const ex = await pool.query<{ e: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'ocr_image_batches'
       ) AS e`
    );
    if (ex.rows[0]?.e) {
      const ocrBatches = await safeCount(
        pool,
        `SELECT COUNT(*)::text AS c FROM ocr_image_batches b WHERE ($1::text IS NULL OR b.project_key = $1)`,
        p,
        0,
        () => {}
      );
      const need = await safeCount(
        pool,
        `SELECT COUNT(*)::text AS c
         FROM ocr_extracted_rows r
         INNER JOIN ocr_image_batches b ON b.id = r.ocr_image_batch_id
         WHERE ($1::text IS NULL OR b.project_key = $1)
           AND r.needs_human_review = true
           AND r.human_review_status IN ('NEEDS_REVIEW','EDITED')`,
        p,
        0,
        () => {}
      );
      const conf = await safeCount(
        pool,
        `SELECT COUNT(*)::text AS c
         FROM ocr_extracted_rows r
         INNER JOIN ocr_image_batches b ON b.id = r.ocr_image_batch_id
         WHERE ($1::text IS NULL OR b.project_key = $1)
           AND r.human_review_status = 'CONFIRMED'`,
        p,
        0,
        () => {}
      );
      const imp = await safeCount(
        pool,
        `SELECT COUNT(*)::text AS c
         FROM ocr_to_import_batches t
         INNER JOIN ocr_image_batches b ON b.id = t.ocr_image_batch_id
         WHERE ($1::text IS NULL OR b.project_key = $1)
           AND t.import_batch_id IS NOT NULL`,
        p,
        0,
        () => {}
      );
      ocr_totals = {
        ocr_batches_total: ocrBatches,
        ocr_rows_needing_review: need,
        ocr_rows_confirmed: conf,
        ocr_rows_imported_links: imp,
      };
    }
  } catch {
    warnings.push("Could not load OCR aggregate stats (check migration 008).");
  }

  if (hasCountyView) {
    try {
      const c = await pool.query<{ petition_code: string; county: string; v: string; a: string | null }>(
        `SELECT c.petition_code,
                c.signer_county AS county,
                c.total_signatures::text AS v,
                c.avg_confidence_pct::text AS a
         FROM initiative_county_counts c
         INNER JOIN petitions p ON p.petition_code = c.petition_code
         WHERE ($1::text IS NULL OR p.project_key = $1)
         ORDER BY c.total_signatures DESC
         LIMIT 120`,
        p
      );
      for (const row of c.rows) {
        county_counts.push({
          petition_code: row.petition_code,
          county: row.county,
          total_signatures: Number.parseInt(row.v, 10) || 0,
          avg_confidence_pct: row.a != null && row.a !== "" ? Number.parseFloat(row.a) : null,
        });
      }
    } catch {
      warnings.push("Could not read initiative_county_counts.");
    }
  }

  return {
    generated_at: new Date().toISOString(),
    database_configured: Boolean(process.env.DATABASE_URL?.trim()),
    totals,
    initiatives,
    recent_batches,
    confidence_distribution,
    problem_counts,
    ward_counts,
    county_counts,
    warnings,
    ocr_totals,
  };
}

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

export type BatchSnapshot = {
  batch_id: string;
  file_name: string;
  petition_code: string | null;
  project_key: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  total_rows: number;
  matched: number;
  not_found: number;
  multiple_matches: number;
  weak_matches: number;
  errors: number;
  under_80: number;
  needs_review: number;
  out_of_jurisdiction: number;
  duplicates: number;
  nonvoters: number;
  confidence_distribution: ConfidenceDistribution;
  problem_counts: ProblemCountRow[];
  ward_counts: WardCountyRow[];
  county_counts: WardCountyRow[];
  warnings: string[];
  /** Present when reporting view exists; null if migrations not applied. */
  review_progress: {
    total_rows: number;
    slam_dunk_matched: number;
    needs_review_total: number;
    unresolved_review_rows: number;
    manually_approved: number;
    rejected: number;
    needs_more_info: number;
    percent_complete: number;
  } | null;
};

export async function fetchBatchReportSnapshot(pool: Pool, batchId: string): Promise<BatchSnapshot | null> {
  const warnings: string[] = [];
  const hasPct = await columnExists(pool, "import_voter_matches", "match_confidence_pct");
  if (!hasPct) warnings.push("Migration needed: match_confidence_pct (006).");

  const hasQueue80 = await viewExists(pool, "initiative_review_queue_80");
  const hasQueueConf = await viewExists(pool, "initiative_review_confidence_queue");

  const meta = await pool.query<{
    batch_id: string;
    file_name: string;
    petition_code: string | null;
    project_key: string;
    status: string;
    created_at: string;
    completed_at: string | null;
    total_rows: string;
  }>(
    `SELECT b.id::text AS batch_id, b.file_name, b.petition_code, b.project_key, b.status,
            b.created_at::text AS created_at, b.completed_at::text AS completed_at, b.total_rows::text AS total_rows
     FROM import_batches b WHERE b.id = $1::uuid`,
    [batchId]
  );
  if (meta.rows.length === 0) return null;
  const m = meta.rows[0]!;

  const base = `FROM import_voter_matches mr WHERE mr.import_batch_id = $1::uuid`;

  const matched = await safeCount(pool, `SELECT COUNT(*)::text AS c ${base} AND mr.match_status = 'MATCHED'`, [batchId], 0, () => {});
  const not_found = await safeCount(pool, `SELECT COUNT(*)::text AS c ${base} AND mr.match_status = 'NOT_FOUND'`, [batchId], 0, () => {});
  const multiple_matches = await safeCount(
    pool,
    `SELECT COUNT(*)::text AS c ${base} AND mr.match_status = 'MULTIPLE_MATCHES'`,
    [batchId],
    0,
    () => {}
  );
  const weak_matches = await safeCount(pool, `SELECT COUNT(*)::text AS c ${base} AND mr.match_status = 'WEAK_MATCH'`, [batchId], 0, () => {});
  const errors = await safeCount(pool, `SELECT COUNT(*)::text AS c ${base} AND mr.match_status = 'ERROR'`, [batchId], 0, () => {});

  let under_80 = 0;
  if (hasPct) {
    under_80 = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c ${base} AND mr.match_confidence_pct IS NOT NULL AND mr.match_confidence_pct < 80`,
      [batchId],
      0,
      () => {}
    );
  }

  let needs_review = 0;
  if (hasQueue80) {
    needs_review = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c FROM initiative_review_queue_80 q WHERE q.import_batch_id = $1::uuid`,
      [batchId],
      0,
      () => {}
    );
  } else if (hasQueueConf) {
    needs_review = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c FROM initiative_review_confidence_queue q WHERE q.import_batch_id = $1::uuid`,
      [batchId],
      0,
      () => {}
    );
  }

  const hasJurisdictionCol = await columnExists(pool, "import_voter_matches", "jurisdiction_status");
  let out_of_jurisdiction = 0;
  if (hasJurisdictionCol) {
    out_of_jurisdiction = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c ${base} AND mr.jurisdiction_status = 'OUT_OF_JURISDICTION'`,
      [batchId],
      0,
      () => {}
    );
  }

  const hasDupCol = await columnExists(pool, "import_voter_matches", "duplicate_status");
  let duplicates = 0;
  if (hasDupCol) {
    duplicates = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c ${base}
       AND mr.duplicate_status IN ('POSSIBLE_DUPLICATE','DUPLICATE_WITHIN_FILE','DUPLICATE_EXISTING_SIGNATURE')`,
      [batchId],
      0,
      () => {}
    );
  }

  const hasNonvoterTable = await tableExists(pool, "initiative_nonvoter_entries");
  let nonvoters = 0;
  if (hasNonvoterTable) {
    nonvoters = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c FROM initiative_nonvoter_entries e WHERE e.import_batch_id = $1::uuid`,
      [batchId],
      0,
      () => {}
    );
  }

  let review_progress: BatchSnapshot["review_progress"] = null;
  try {
    review_progress = await runReviewProgress(pool, batchId);
  } catch {
    warnings.push("Could not compute review progress (apply migrations 005+ or check batch_signature_report_rows).");
  }

  const confidence_distribution: ConfidenceDistribution = {
    pct_100: 0,
    pct_90_99: 0,
    pct_80_89: 0,
    pct_50_79: 0,
    pct_1_49: 0,
    pct_0: 0,
  };
  if (hasPct) {
    const dist = await pool.query<{ bucket: string; c: string }>(
      `SELECT
         CASE
           WHEN mr.match_confidence_pct >= 100 THEN 'pct_100'
           WHEN mr.match_confidence_pct >= 90 THEN 'pct_90_99'
           WHEN mr.match_confidence_pct >= 80 THEN 'pct_80_89'
           WHEN mr.match_confidence_pct >= 50 THEN 'pct_50_79'
           WHEN mr.match_confidence_pct >= 1 THEN 'pct_1_49'
           ELSE 'pct_0'
         END AS bucket,
         COUNT(*)::text AS c
       ${base}
       AND mr.match_confidence_pct IS NOT NULL
       GROUP BY 1`,
      [batchId]
    );
    for (const row of dist.rows) {
      const n = Number.parseInt(row.c, 10) || 0;
      if (row.bucket === "pct_100") confidence_distribution.pct_100 = n;
      else if (row.bucket === "pct_90_99") confidence_distribution.pct_90_99 = n;
      else if (row.bucket === "pct_80_89") confidence_distribution.pct_80_89 = n;
      else if (row.bucket === "pct_50_79") confidence_distribution.pct_50_79 = n;
      else if (row.bucket === "pct_1_49") confidence_distribution.pct_1_49 = n;
      else if (row.bucket === "pct_0") confidence_distribution.pct_0 = n;
    }
  }

  const problem_counts: ProblemCountRow[] = [
    { problem: "MATCHED", count: matched },
    { problem: "NOT_FOUND", count: not_found },
    { problem: "MULTIPLE_MATCHES", count: multiple_matches },
    { problem: "WEAK_MATCH", count: weak_matches },
    { problem: "ERROR", count: errors },
    { problem: "NEEDS_REVIEW", count: needs_review },
    { problem: "UNDER_80", count: under_80 },
    { problem: "OUT_OF_JURISDICTION", count: out_of_jurisdiction },
    { problem: "DUPLICATE_FLAGS", count: duplicates },
  ].sort((a, b) => b.count - a.count);

  const ward_counts: WardCountyRow[] = [];
  const county_counts: WardCountyRow[] = [];
  const hasSigWard = await columnExists(pool, "voter_petition_signatures", "voter_ward");
  const hasSigCounty = await columnExists(pool, "voter_petition_signatures", "signer_county");
  const batchSigPct = await columnExists(pool, "voter_petition_signatures", "match_confidence_pct");
  try {
    if (hasSigWard) {
      const w = await pool.query<{ ward: string; c: string; a: string | null }>(
        `SELECT COALESCE(NULLIF(btrim(s.voter_ward), ''), 'UNKNOWN') AS ward,
                COUNT(*)::text AS c,
                ${
                  batchSigPct
                    ? `ROUND(AVG(s.match_confidence_pct)::numeric, 1)::text`
                    : `NULL::text`
                } AS a
         FROM voter_petition_signatures s
         WHERE s.import_batch_id = $1::uuid
         GROUP BY 1
         ORDER BY COUNT(*) DESC
         LIMIT 40`,
        [batchId]
      );
      const pc = m.petition_code ?? "";
      for (const row of w.rows) {
        ward_counts.push({
          petition_code: pc,
          ward: row.ward,
          total_signatures: Number.parseInt(row.c, 10) || 0,
          avg_confidence_pct: row.a != null && row.a !== "" ? Number.parseFloat(row.a) : null,
        });
      }
    }
  } catch {
    warnings.push("Could not load batch ward rollup from voter_petition_signatures.");
  }
  try {
    if (hasSigCounty) {
      const c = await pool.query<{ county: string; v: string; a: string | null }>(
        `SELECT COALESCE(NULLIF(btrim(s.signer_county), ''), 'UNKNOWN') AS county,
                COUNT(*)::text AS v,
                ${
                  batchSigPct
                    ? `ROUND(AVG(s.match_confidence_pct)::numeric, 1)::text`
                    : `NULL::text`
                } AS a
         FROM voter_petition_signatures s
         WHERE s.import_batch_id = $1::uuid
         GROUP BY 1
         ORDER BY COUNT(*) DESC
         LIMIT 40`,
        [batchId]
      );
      const pc = m.petition_code ?? "";
      for (const row of c.rows) {
        county_counts.push({
          petition_code: pc,
          county: row.county,
          total_signatures: Number.parseInt(row.v, 10) || 0,
          avg_confidence_pct: row.a != null && row.a !== "" ? Number.parseFloat(row.a) : null,
        });
      }
    }
  } catch {
    warnings.push("Could not load batch county rollup from voter_petition_signatures.");
  }

  return {
    batch_id: m.batch_id,
    file_name: m.file_name,
    petition_code: m.petition_code,
    project_key: m.project_key,
    status: m.status,
    created_at: m.created_at,
    completed_at: m.completed_at,
    total_rows: Number.parseInt(m.total_rows, 10) || 0,
    matched,
    not_found,
    multiple_matches,
    weak_matches,
    errors,
    under_80,
    needs_review,
    out_of_jurisdiction,
    duplicates,
    nonvoters,
    confidence_distribution,
    problem_counts,
    ward_counts,
    county_counts,
    warnings,
    review_progress,
  };
}

export type InitiativeSnapshot = {
  petition_code: string;
  petition_name: string;
  initiative_scope: string | null;
  reporting_geo: string | null;
  jurisdiction_name: string | null;
  jurisdiction_city: string | null;
  jurisdiction_county: string | null;
  jurisdiction_state: string | null;
  jurisdiction_type: string | null;
  target_signature_count: number | null;
  total_signatures: number;
  valid_in_jurisdiction_signatures: number;
  needs_review: number;
  nonvoters: number;
  out_of_jurisdiction: number;
  duplicates: number;
  under_80: number;
  confidence_distribution: ConfidenceDistribution;
  ward_counts: WardCountyRow[];
  county_counts: WardCountyRow[];
  recent_batches: RecentBatchRow[];
  warnings: string[];
};

export async function fetchInitiativeReportSnapshot(pool: Pool, petitionCode: string): Promise<InitiativeSnapshot | null> {
  const warnings: string[] = [];
  const pc = petitionCode.trim();
  if (!pc) return null;

  const pet = await pool.query<{
    petition_code: string;
    petition_name: string;
    initiative_scope: string | null;
    reporting_geo: string | null;
    jurisdiction_name: string | null;
    jurisdiction_city: string | null;
    jurisdiction_county: string | null;
    jurisdiction_state: string | null;
    jurisdiction_type: string | null;
    target_signature_count: string | null;
  }>(
    `SELECT petition_code, petition_name, initiative_scope, reporting_geo,
            jurisdiction_name, jurisdiction_city, jurisdiction_county, jurisdiction_state, jurisdiction_type,
            target_signature_count::text
     FROM petitions WHERE petition_code = $1`,
    [pc]
  );
  if (pet.rows.length === 0) return null;
  const p = pet.rows[0]!;

  const hasPct = await columnExists(pool, "import_voter_matches", "match_confidence_pct");
  const hasQueue80 = await viewExists(pool, "initiative_review_queue_80");
  const hasQueueConf = await viewExists(pool, "initiative_review_confidence_queue");
  const hasNonvoter = await tableExists(pool, "initiative_nonvoter_entries");
  const hasJurisdictionCol = await columnExists(pool, "import_voter_matches", "jurisdiction_status");
  const hasDupCol = await columnExists(pool, "import_voter_matches", "duplicate_status");
  const hasSigJurisdiction = await columnExists(pool, "voter_petition_signatures", "jurisdiction_status");
  if (!hasSigJurisdiction) {
    warnings.push("Migration needed: voter_petition_signatures.jurisdiction_status missing (apply 007).");
  }

  const total_signatures = await safeCount(
    pool,
    `SELECT COUNT(*)::text AS c FROM voter_petition_signatures s WHERE s.petition_code = $1`,
    [pc],
    0,
    () => {}
  );
  let valid_in_jurisdiction_signatures = total_signatures;
  if (hasSigJurisdiction) {
    valid_in_jurisdiction_signatures = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c FROM voter_petition_signatures s
       WHERE s.petition_code = $1
         AND COALESCE(s.jurisdiction_status, 'IN_JURISDICTION') = 'IN_JURISDICTION'`,
      [pc],
      0,
      () => {}
    );
  }

  let needs_review = 0;
  if (hasQueue80) {
    needs_review = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c FROM initiative_review_queue_80 WHERE petition_code = $1`,
      [pc],
      0,
      () => {}
    );
  } else if (hasQueueConf) {
    needs_review = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c FROM initiative_review_confidence_queue WHERE petition_code = $1`,
      [pc],
      0,
      () => {}
    );
  }

  const nonvoters = hasNonvoter
    ? await safeCount(pool, `SELECT COUNT(*)::text AS c FROM initiative_nonvoter_entries WHERE petition_code = $1`, [pc], 0, () => {})
    : 0;

  let out_of_jurisdiction = 0;
  if (hasJurisdictionCol) {
    out_of_jurisdiction = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c
       FROM import_voter_matches mr
       INNER JOIN import_batches b ON b.id = mr.import_batch_id
       WHERE b.petition_code = $1 AND mr.jurisdiction_status = 'OUT_OF_JURISDICTION'`,
      [pc],
      0,
      () => {}
    );
  }

  let duplicates = 0;
  if (hasDupCol) {
    duplicates = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c
       FROM import_voter_matches mr
       INNER JOIN import_batches b ON b.id = mr.import_batch_id
       WHERE b.petition_code = $1
         AND mr.duplicate_status IN ('POSSIBLE_DUPLICATE','DUPLICATE_WITHIN_FILE','DUPLICATE_EXISTING_SIGNATURE')`,
      [pc],
      0,
      () => {}
    );
  }

  let under_80 = 0;
  if (hasPct) {
    under_80 = await safeCount(
      pool,
      `SELECT COUNT(*)::text AS c
       FROM import_voter_matches mr
       INNER JOIN import_batches b ON b.id = mr.import_batch_id
       WHERE b.petition_code = $1
         AND mr.match_confidence_pct IS NOT NULL AND mr.match_confidence_pct < 80`,
      [pc],
      0,
      () => {}
    );
  }

  const confidence_distribution: ConfidenceDistribution = {
    pct_100: 0,
    pct_90_99: 0,
    pct_80_89: 0,
    pct_50_79: 0,
    pct_1_49: 0,
    pct_0: 0,
  };
  if (hasPct) {
    const dist = await pool.query<{ bucket: string; c: string }>(
      `SELECT
         CASE
           WHEN mr.match_confidence_pct >= 100 THEN 'pct_100'
           WHEN mr.match_confidence_pct >= 90 THEN 'pct_90_99'
           WHEN mr.match_confidence_pct >= 80 THEN 'pct_80_89'
           WHEN mr.match_confidence_pct >= 50 THEN 'pct_50_79'
           WHEN mr.match_confidence_pct >= 1 THEN 'pct_1_49'
           ELSE 'pct_0'
         END AS bucket,
         COUNT(*)::text AS c
       FROM import_voter_matches mr
       INNER JOIN import_batches b ON b.id = mr.import_batch_id
       WHERE b.petition_code = $1 AND mr.match_confidence_pct IS NOT NULL
       GROUP BY 1`,
      [pc]
    );
    for (const row of dist.rows) {
      const n = Number.parseInt(row.c, 10) || 0;
      if (row.bucket === "pct_100") confidence_distribution.pct_100 = n;
      else if (row.bucket === "pct_90_99") confidence_distribution.pct_90_99 = n;
      else if (row.bucket === "pct_80_89") confidence_distribution.pct_80_89 = n;
      else if (row.bucket === "pct_50_79") confidence_distribution.pct_50_79 = n;
      else if (row.bucket === "pct_1_49") confidence_distribution.pct_1_49 = n;
      else if (row.bucket === "pct_0") confidence_distribution.pct_0 = n;
    }
  }

  const ward_counts: WardCountyRow[] = [];
  const county_counts: WardCountyRow[] = [];
  const hasSigWard = await columnExists(pool, "voter_petition_signatures", "voter_ward");
  const hasSigCounty = await columnExists(pool, "voter_petition_signatures", "signer_county");
  const hasSigPctCol = await columnExists(pool, "voter_petition_signatures", "match_confidence_pct");
  try {
    if (hasSigWard) {
      const wc = await pool.query<{ ward: string; c: string; a: string | null }>(
        `SELECT COALESCE(NULLIF(btrim(s.voter_ward), ''), 'UNKNOWN') AS ward,
                COUNT(*)::text AS c,
                ${hasSigPctCol ? `ROUND(AVG(s.match_confidence_pct)::numeric, 1)::text` : `NULL::text`} AS a
         FROM voter_petition_signatures s
         WHERE s.petition_code = $1
         GROUP BY 1
         ORDER BY COUNT(*) DESC
         LIMIT 60`,
        [pc]
      );
      for (const row of wc.rows) {
        ward_counts.push({
          petition_code: pc,
          ward: row.ward,
          total_signatures: Number.parseInt(row.c, 10) || 0,
          avg_confidence_pct: row.a != null && row.a !== "" ? Number.parseFloat(row.a) : null,
        });
      }
    }
  } catch {
    warnings.push("Could not load initiative ward rollup.");
  }
  try {
    if (hasSigCounty) {
      const cc = await pool.query<{ county: string; v: string; a: string | null }>(
        `SELECT COALESCE(NULLIF(btrim(s.signer_county), ''), 'UNKNOWN') AS county,
                COUNT(*)::text AS v,
                ${hasSigPctCol ? `ROUND(AVG(s.match_confidence_pct)::numeric, 1)::text` : `NULL::text`} AS a
         FROM voter_petition_signatures s
         WHERE s.petition_code = $1
         GROUP BY 1
         ORDER BY COUNT(*) DESC
         LIMIT 60`,
        [pc]
      );
      for (const row of cc.rows) {
        county_counts.push({
          petition_code: pc,
          county: row.county,
          total_signatures: Number.parseInt(row.v, 10) || 0,
          avg_confidence_pct: row.a != null && row.a !== "" ? Number.parseFloat(row.a) : null,
        });
      }
    }
  } catch {
    warnings.push("Could not load initiative county rollup.");
  }

  const batchAgg = await pool.query<{
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
     WHERE b.petition_code = $1
     GROUP BY b.id
     ORDER BY b.created_at DESC
     LIMIT 25`,
    [pc]
  );

  const batchIds = batchAgg.rows.map((r) => r.batch_id);
  const underMap = new Map<string, number>();
  const reviewMap = new Map<string, number>();
  if (batchIds.length > 0 && hasPct) {
    const u = await pool.query<{ id: string; c: string }>(
      `SELECT mr.import_batch_id::text AS id, COUNT(*)::text AS c
       FROM import_voter_matches mr
       WHERE mr.import_batch_id = ANY($1::uuid[])
         AND mr.match_confidence_pct IS NOT NULL AND mr.match_confidence_pct < 80
       GROUP BY mr.import_batch_id`,
      [batchIds]
    );
    for (const row of u.rows) underMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  }
  if (batchIds.length > 0 && hasQueue80) {
    const rv = await pool.query<{ id: string; c: string }>(
      `SELECT import_batch_id::text AS id, COUNT(*)::text AS c
       FROM initiative_review_queue_80 WHERE import_batch_id = ANY($1::uuid[]) GROUP BY import_batch_id`,
      [batchIds]
    );
    for (const row of rv.rows) reviewMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  } else if (batchIds.length > 0 && hasQueueConf) {
    const rv = await pool.query<{ id: string; c: string }>(
      `SELECT import_batch_id::text AS id, COUNT(*)::text AS c
       FROM initiative_review_confidence_queue WHERE import_batch_id = ANY($1::uuid[]) GROUP BY import_batch_id`,
      [batchIds]
    );
    for (const row of rv.rows) reviewMap.set(row.id, Number.parseInt(row.c, 10) || 0);
  }

  const recent_batches: RecentBatchRow[] = batchAgg.rows.map((b) => ({
    batch_id: b.batch_id,
    file_name: b.file_name,
    petition_code: b.petition_code,
    project_key: b.project_key,
    total_rows: Number.parseInt(b.total_rows, 10) || 0,
    matched: Number.parseInt(b.matched, 10) || 0,
    not_found: Number.parseInt(b.not_found, 10) || 0,
    multiple_matches: Number.parseInt(b.multiple_matches, 10) || 0,
    weak_matches: Number.parseInt(b.weak_matches, 10) || 0,
    errors: Number.parseInt(b.errors, 10) || 0,
    under_80: underMap.get(b.batch_id) ?? 0,
    needs_review: reviewMap.get(b.batch_id) ?? 0,
    status: b.status,
    created_at: b.created_at,
    completed_at: b.completed_at,
  }));

  return {
    petition_code: p.petition_code,
    petition_name: p.petition_name,
    initiative_scope: p.initiative_scope,
    reporting_geo: p.reporting_geo,
    jurisdiction_name: p.jurisdiction_name,
    jurisdiction_city: p.jurisdiction_city,
    jurisdiction_county: p.jurisdiction_county,
    jurisdiction_state: p.jurisdiction_state,
    jurisdiction_type: p.jurisdiction_type,
    target_signature_count: p.target_signature_count != null ? Number.parseInt(p.target_signature_count, 10) : null,
    total_signatures,
    valid_in_jurisdiction_signatures,
    needs_review,
    nonvoters,
    out_of_jurisdiction,
    duplicates,
    under_80,
    confidence_distribution,
    ward_counts,
    county_counts,
    recent_batches,
    warnings,
  };
}
