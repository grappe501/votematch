import type { Pool, PoolClient } from "pg";
import { fetchTableColumnNames } from "./db.js";
import { readMatchSourceTableEnv } from "./matchSource.js";

export type InitiativeScope = "CITY" | "COUNTY" | "STATEWIDE" | "DISTRICT" | "OTHER" | string;
export type ReportingGeo = "WARD" | "COUNTY" | "PRECINCT" | "DISTRICT" | "CITY" | "NONE" | string;

export type InitiativeRow = {
  id: string;
  petition_code: string;
  petition_name: string;
  initiative_scope: string | null;
  reporting_geo: string | null;
  target_signature_count: number | null;
  notes: string | null;
  project_key: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type DbQueryable = Pick<Pool | PoolClient, "query">;

export async function upsertInitiative(
  pool: DbQueryable,
  opts: {
    petitionCode: string;
    petitionName: string;
    projectKey?: string | null;
    initiativeScope?: InitiativeScope | null;
    reportingGeo?: ReportingGeo | null;
    targetSignatureCount?: number | null;
    notes?: string | null;
  }
): Promise<{ petition_id: string; created: boolean }> {
  const code = opts.petitionCode.trim();
  const name = opts.petitionName.trim();
  if (!code) throw new Error("petition_code is required.");
  if (!name) throw new Error("petition_name is required for upsert.");

  const existing = await pool.query<{ id: string }>(`SELECT id FROM petitions WHERE petition_code = $1`, [code]);
  const created = existing.rows.length === 0;

  const r = await pool.query<{ id: string }>(
    `INSERT INTO petitions (
      petition_code, petition_name, project_key,
      initiative_scope, reporting_geo, target_signature_count, notes,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
    ON CONFLICT (petition_code) DO UPDATE SET
      petition_name = EXCLUDED.petition_name,
      project_key = COALESCE(EXCLUDED.project_key, petitions.project_key),
      initiative_scope = COALESCE(EXCLUDED.initiative_scope, petitions.initiative_scope),
      reporting_geo = COALESCE(EXCLUDED.reporting_geo, petitions.reporting_geo),
      target_signature_count = COALESCE(EXCLUDED.target_signature_count, petitions.target_signature_count),
      notes = COALESCE(EXCLUDED.notes, petitions.notes),
      updated_at = now()
    RETURNING id`,
    [
      code,
      name,
      opts.projectKey?.trim() ?? null,
      opts.initiativeScope?.trim() ?? null,
      opts.reportingGeo?.trim() ?? null,
      opts.targetSignatureCount ?? null,
      opts.notes?.trim() ?? null,
    ]
  );
  return { petition_id: r.rows[0]!.id, created };
}

export async function fetchInitiativeByCode(pool: Pool, petitionCode: string): Promise<InitiativeRow | null> {
  const r = await pool.query<InitiativeRow>(
    `SELECT id, petition_code, petition_name, initiative_scope, reporting_geo, target_signature_count,
            notes, project_key, status, created_at::text, updated_at::text
     FROM petitions WHERE petition_code = $1`,
    [petitionCode.trim()]
  );
  return r.rows[0] ?? null;
}

export type ListInitiativesFilters = {
  projectKey?: string | null;
  status?: string | null;
  limit: number;
};

export async function listInitiatives(pool: Pool, filters: ListInitiativesFilters): Promise<
  {
    petition_code: string;
    petition_name: string;
    initiative_scope: string | null;
    reporting_geo: string | null;
    target_signature_count: number | null;
    total_signatures: number;
    latest_signature_at: string | null;
  }[]
> {
  const lim = Math.min(Math.max(filters.limit, 1), 500);
  const conds: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (filters.projectKey?.trim()) {
    conds.push(`p.project_key = $${i++}`);
    vals.push(filters.projectKey.trim());
  }
  if (filters.status?.trim()) {
    conds.push(`p.status = $${i++}`);
    vals.push(filters.status.trim());
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  vals.push(lim);
  const r = await pool.query<{
    petition_code: string;
    petition_name: string;
    initiative_scope: string | null;
    reporting_geo: string | null;
    target_signature_count: number | null;
    total_signatures: string;
    latest_signature_at: string | null;
  }>(
    `SELECT p.petition_code, p.petition_name, p.initiative_scope, p.reporting_geo, p.target_signature_count,
            COALESCE(COUNT(s.id), 0)::text AS total_signatures,
            MAX(s.updated_at)::text AS latest_signature_at
     FROM petitions p
     LEFT JOIN voter_petition_signatures s ON s.petition_id = p.id
     ${where}
     GROUP BY p.id, p.petition_code, p.petition_name, p.initiative_scope, p.reporting_geo, p.target_signature_count
     ORDER BY p.updated_at DESC
     LIMIT $${i}`,
    vals
  );
  return r.rows.map((row) => ({
    petition_code: row.petition_code,
    petition_name: row.petition_name,
    initiative_scope: row.initiative_scope,
    reporting_geo: row.reporting_geo,
    target_signature_count: row.target_signature_count,
    total_signatures: Number.parseInt(row.total_signatures, 10),
    latest_signature_at: row.latest_signature_at,
  }));
}

export type InitiativeSummaryJson = {
  petition_code: string;
  petition_name: string | null;
  initiative_scope: string | null;
  reporting_geo: string | null;
  target_signature_count: number | null;
  total_signatures: number;
  remaining_to_target: number | null;
  percent_to_target: number | null;
  total_by_ward: Record<string, number> | null;
  total_by_county: Record<string, number> | null;
  review_remaining: number;
  confidence_distribution: Record<string, number>;
  avg_confidence_pct: number | null;
};

export async function getInitiativeSummary(pool: Pool, petitionCode: string): Promise<InitiativeSummaryJson> {
  const pet = await fetchInitiativeByCode(pool, petitionCode);
  if (!pet) throw new Error(`Initiative not found: ${petitionCode}`);

  const rollup = await pool.query<{
    total_signatures: string;
    avg_confidence_pct: string | null;
  }>(
    `SELECT COUNT(s.id)::text AS total_signatures,
            ROUND(AVG(s.match_confidence_pct)::numeric, 1)::text AS avg_confidence_pct
     FROM voter_petition_signatures s
     WHERE s.petition_code = $1`,
    [petitionCode]
  );
  const total = Number.parseInt(rollup.rows[0]?.total_signatures ?? "0", 10);
  const avg = rollup.rows[0]?.avg_confidence_pct != null ? Number.parseFloat(rollup.rows[0]!.avg_confidence_pct!) : null;

  const target = pet.target_signature_count;
  const remaining = target != null && target > 0 ? Math.max(0, target - total) : null;
  const pctToTarget = target != null && target > 0 ? Math.min(100, (total / target) * 100) : null;

  let total_by_ward: Record<string, number> | null = null;
  if ((pet.reporting_geo ?? "").toUpperCase() === "WARD") {
    const w = await pool.query<{ k: string; c: string }>(
      `SELECT voter_ward AS k, total_signatures::text AS c FROM initiative_ward_counts WHERE petition_code = $1`,
      [petitionCode]
    );
    total_by_ward = {};
    for (const row of w.rows) total_by_ward[row.k] = Number.parseInt(row.c, 10);
  }

  let total_by_county: Record<string, number> | null = null;
  const geo = (pet.reporting_geo ?? "").toUpperCase();
  if (geo === "COUNTY" || (pet.initiative_scope ?? "").toUpperCase() === "STATEWIDE") {
    const c = await pool.query<{ k: string; v: string }>(
      `SELECT signer_county AS k, total_signatures::text AS v FROM initiative_county_counts WHERE petition_code = $1`,
      [petitionCode]
    );
    total_by_county = {};
    for (const row of c.rows) total_by_county[row.k] = Number.parseInt(row.v, 10);
  }

  const rq = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM initiative_review_confidence_queue WHERE petition_code = $1`,
    [petitionCode]
  );
  const review_remaining = Number.parseInt(rq.rows[0]?.c ?? "0", 10);

  const dist = await pool.query<{ bucket: string; c: string }>(
    `SELECT
       CASE
         WHEN mr.match_confidence_pct IS NULL THEN 'unknown'
         WHEN mr.match_confidence_pct >= 100 THEN '100'
         WHEN mr.match_confidence_pct >= 90 THEN '90_99'
         WHEN mr.match_confidence_pct >= 75 THEN '75_89'
         WHEN mr.match_confidence_pct >= 50 THEN '50_74'
         WHEN mr.match_confidence_pct >= 1 THEN '1_49'
         ELSE '0'
       END AS bucket,
       COUNT(*)::text AS c
     FROM import_voter_matches mr
     INNER JOIN import_batches b ON b.id = mr.import_batch_id
     WHERE b.petition_code = $1
     GROUP BY 1`,
    [petitionCode]
  );
  const confidence_distribution: Record<string, number> = {};
  for (const row of dist.rows) {
    confidence_distribution[row.bucket] = Number.parseInt(row.c, 10);
  }

  return {
    petition_code: pet.petition_code,
    petition_name: pet.petition_name,
    initiative_scope: pet.initiative_scope,
    reporting_geo: pet.reporting_geo,
    target_signature_count: pet.target_signature_count,
    total_signatures: total,
    remaining_to_target: remaining,
    percent_to_target: pctToTarget,
    total_by_ward,
    total_by_county,
    review_remaining,
    confidence_distribution,
    avg_confidence_pct: avg,
  };
}

export type ExecutionGuardResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export async function validateInitiativeExecutionGuards(
  pool: Pool,
  opts: {
    petitionCode: string;
    petitionName: string;
    autoCreateInitiative: boolean;
    initiativeScope?: string | null;
    reportingGeo?: string | null;
    targetSignatureCount?: number | null;
    profileName?: string | null;
  }
): Promise<ExecutionGuardResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pet = await fetchInitiativeByCode(pool, opts.petitionCode);
  if (!pet && !opts.autoCreateInitiative) {
    errors.push(
      `Initiative ${opts.petitionCode} does not exist. Run --upsert-initiative first, or pass --auto-create-initiative with name/scope/geo.`
    );
  }
  if (!pet && opts.autoCreateInitiative) {
    if (!opts.petitionName?.trim()) errors.push("--petition-name is required when using --auto-create-initiative.");
    if (!opts.reportingGeo?.trim()) errors.push("--reporting-geo is required when using --auto-create-initiative.");
  }
  const reportingResolved = ((pet?.reporting_geo ?? opts.reportingGeo) ?? "").trim();
  if (pet && !reportingResolved) {
    errors.push(
      `Initiative ${opts.petitionCode} has no reporting_geo in the database. Set it with --upsert-initiative or pass --reporting-geo (e.g. with --auto-create-initiative).`
    );
  }

  const ms = readMatchSourceTableEnv();
  const geo = reportingResolved.toUpperCase();
  if (ms && geo === "WARD") {
    const cols = await fetchTableColumnNames(pool, ms);
    const hasWard = ["ward", "ward_norm", "district", "district_norm"].some((c) => {
      const low = c.toLowerCase();
      for (const x of cols) if (x.toLowerCase() === low) return true;
      return false;
    });
    if (!hasWard) {
      warnings.push(
        "reporting_geo is WARD but VFM_MATCH_SOURCE_TABLE lacks ward/district columns; ward rollups will use UNKNOWN until the match source is extended."
      );
    }
  }
  if (geo === "COUNTY" && ms) {
    const cols = await fetchTableColumnNames(pool, ms);
    const hasCounty = ["county", "county_norm"].some((c) => {
      const low = c.toLowerCase();
      for (const x of cols) if (x.toLowerCase() === low) return true;
      return false;
    });
    if (!hasCounty) {
      warnings.push(
        "reporting_geo is COUNTY-centric but match source may lack county_norm; verify signer_county on imports."
      );
    }
  }

  if (opts.profileName === "petition-mail-list-share-v1" && errors.length === 0 && !pet && !opts.autoCreateInitiative) {
    errors.push("petition-mail-list-share-v1 imports require an existing initiative or --auto-create-initiative.");
  }

  return { ok: errors.length === 0, errors, warnings };
}
