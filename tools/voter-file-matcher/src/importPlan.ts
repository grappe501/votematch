import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Pool } from "pg";
import { createPool } from "./db.js";
import { computeFileSha256, getFileSizeBytes, shortHash } from "./fileHash.js";
import { runFullImport } from "./importRunner.js";
import { loadHeaderMapFile } from "./headerMap.js";
import { runPreflightOnSheet } from "./preflight.js";
import type { ParseFileOptions } from "./parseFile.js";
import { parseVoterBuffer } from "./parseFile.js";
import { defaultImportPlanOutPath } from "./reports.js";
import { fetchInitiativeByCode, upsertInitiative } from "./initiatives.js";
import {
  evaluateCandidateProbe,
  evaluateMatchReadiness,
  readMatchSourceTableEnv,
  type MatchReadinessResult,
} from "./matchSource.js";
import type {
  CandidateProbeSummary,
  ImportPlanJson,
  PreflightSummaryJson,
  VoterHeaderMapFile,
} from "./types.js";

const PLAN_KEY_SAFE = /^[a-zA-Z0-9_.-]+$/;

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

function sanitizeKeyPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export function derivePlanKey(projectKey: string, petitionCode: string, fileSha256: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const sh = shortHash(fileSha256, 12);
  return `${sanitizeKeyPart(projectKey)}_${sanitizeKeyPart(petitionCode)}_${stamp}_${sh}`;
}

export function computeImportPlanBlocking(
  pf: PreflightSummaryJson,
  readiness: MatchReadinessResult,
  probe: CandidateProbeSummary
): string[] {
  const blocking: string[] = [];
  if (!pf.ready_for_import) blocking.push("preflight_not_ready");
  if (!readiness.db_match_source_ready) blocking.push("db_match_source_not_ready");
  if (readiness.projected_matching_quality !== "strong" && readiness.projected_matching_quality !== "partial") {
    blocking.push(`projected_quality_${readiness.projected_matching_quality}`);
  }
  if (pf.row_count === 0) blocking.push("zero_rows");
  if (probe.sampled_rows > 0 && probe.errors === probe.sampled_rows) {
    blocking.push("candidate_probe_all_errors");
  }
  return blocking;
}

export function computeImportPlanDecision(
  pf: PreflightSummaryJson,
  readiness: MatchReadinessResult,
  probe: CandidateProbeSummary
): ImportPlanJson["decision"] {
  const blocking_reasons = computeImportPlanBlocking(pf, readiness, probe);
  const warnings = dedupeStrings([
    ...(pf.warnings ?? []),
    ...readiness.reasons,
    ...readiness.missing_recommended_db_fields.map((m: string) => `db_recommended_missing:${m}`),
  ]);
  const ready_for_import = blocking_reasons.length === 0;
  return {
    ready_for_import,
    projected_matching_quality: readiness.projected_matching_quality,
    blocking_reasons,
    warnings,
  };
}

function dedupeStrings(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export type PrepareImportPlanParams = {
  filePath: string;
  mapPath: string;
  projectKey: string;
  petitionCode: string;
  petitionName: string;
  sourceLabel: string | null;
  candidateProbeLimit: number;
  operatorNote: string | null;
  outPath?: string;
  /** When true, upserts initiative (petition) before snapshotting the plan. */
  autoCreateInitiative?: boolean;
  initiativeScope?: string | null;
  reportingGeo?: string | null;
  targetSignatureCount?: number | null;
  initiativeNotes?: string | null;
};

export async function prepareImportPlan(
  pool: Pool,
  params: PrepareImportPlanParams
): Promise<{ plan: ImportPlanJson; written: string }> {
  const mapFile = await loadHeaderMapFile(params.mapPath);
  const buf = await readFile(params.filePath);
  const sheet = parseVoterBuffer(buf, params.filePath, parseFileOptionsFromMap(mapFile));
  const pf = runPreflightOnSheet(sheet, params.filePath, mapFile);
  const readiness = await evaluateMatchReadiness(pool, pf, mapFile);
  const canonical = process.env.VFM_CANONICAL_TABLE?.trim() ?? null;
  if (!canonical) {
    throw new Error("VFM_CANONICAL_TABLE must be set to run candidate probe for import plan.");
  }
  const probe = await evaluateCandidateProbe(pool, canonical, mapFile, sheet, params.candidateProbeLimit);
  const sha = await computeFileSha256(params.filePath);
  const size = await getFileSizeBytes(params.filePath).catch(() => null);
  const plan_key = derivePlanKey(params.projectKey, params.petitionCode, sha);
  if (!PLAN_KEY_SAFE.test(plan_key)) {
    throw new Error("Derived plan_key failed validation.");
  }
  const baseDecision = computeImportPlanDecision(pf, readiness, probe);
  const ms = readMatchSourceTableEnv();

  if (params.autoCreateInitiative === true) {
    await upsertInitiative(pool, {
      petitionCode: params.petitionCode,
      petitionName: params.petitionName,
      projectKey: params.projectKey,
      initiativeScope: params.initiativeScope ?? null,
      reportingGeo: params.reportingGeo ?? null,
      targetSignatureCount: params.targetSignatureCount ?? null,
      notes: params.initiativeNotes ?? null,
    });
  }

  const petRow = await fetchInitiativeByCode(pool, params.petitionCode);
  const initiativeWarnings: string[] = [];
  if (!petRow && params.autoCreateInitiative !== true) {
    initiativeWarnings.push(
      "Initiative does not exist yet. Run --upsert-initiative before executing (or prepare with --auto-create-initiative)."
    );
  }
  const petitionNameForPlan = petRow?.petition_name ?? params.petitionName;

  const plan: ImportPlanJson = {
    plan_version: 1,
    plan_key,
    created_at: new Date().toISOString(),
    project_key: params.projectKey,
    petition_code: params.petitionCode,
    petition_name: petitionNameForPlan,
    source_label: params.sourceLabel,
    source_file: {
      path: params.filePath.replace(/\\/g, "/"),
      name: basename(params.filePath),
      sha256: sha,
      size_bytes: size,
    },
    source_profile: {
      path: params.mapPath.replace(/\\/g, "/"),
      profile_name: mapFile.profileName ?? null,
    },
    map: {
      path: mapFile.profileName ? null : params.mapPath.replace(/\\/g, "/"),
    },
    canonical_table: canonical,
    match_source: {
      mode: readiness.match_source_mode,
      table: ms,
    },
    preflight: pf,
    readiness: { ...readiness },
    candidate_probe: probe,
    decision: {
      ...baseDecision,
      warnings: dedupeStrings([...baseDecision.warnings, ...initiativeWarnings]),
    },
    auto_create_initiative: params.autoCreateInitiative === true,
    initiative_snapshot: petRow
      ? {
          initiative_scope: petRow.initiative_scope,
          reporting_geo: petRow.reporting_geo,
          target_signature_count: petRow.target_signature_count,
          existed_in_database: true,
        }
      : {
          initiative_scope: params.initiativeScope ?? null,
          reporting_geo: params.reportingGeo ?? null,
          target_signature_count: params.targetSignatureCount ?? null,
          existed_in_database: false,
        },
    operator_review: {
      status: "DRAFT",
      reviewed_by: null,
      reviewed_at: null,
      note: params.operatorNote,
    },
    execution: {
      executed: false,
      import_batch_id: null,
      executed_at: null,
    },
  };

  const written = params.outPath ?? defaultImportPlanOutPath(plan_key);
  await mkdir(dirname(written), { recursive: true });
  await writeFile(written, JSON.stringify(plan, null, 2), "utf8");
  return { plan, written };
}

export async function readImportPlan(planPath: string): Promise<ImportPlanJson> {
  const raw = await readFile(planPath, "utf8");
  const j = JSON.parse(raw) as ImportPlanJson;
  if (!j || j.plan_version !== 1 || !j.plan_key) {
    throw new Error("Invalid import plan JSON.");
  }
  return j;
}

export async function reviewImportPlan(
  planPath: string,
  opts: { reviewedBy: string; note: string | null; allowReviewWithWarnings: boolean; savePlanDb: boolean }
): Promise<ImportPlanJson> {
  const plan = await readImportPlan(planPath);
  if (!opts.allowReviewWithWarnings && !plan.decision.ready_for_import) {
    throw new Error(
      "Plan decision.ready_for_import is false; pass --allow-review-with-warnings to mark REVIEWED anyway."
    );
  }
  plan.operator_review = {
    status: "REVIEWED",
    reviewed_by: opts.reviewedBy,
    reviewed_at: new Date().toISOString(),
    note: opts.note ?? plan.operator_review.note ?? null,
  };
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  if (opts.savePlanDb) {
    const pool = createPool();
    try {
      await saveImportPlanToDb(pool, plan);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  return plan;
}

export function validatePlanForExecution(
  plan: ImportPlanJson,
  opts: { currentSha256: string; allowHashMismatch: boolean }
): void {
  if (plan.operator_review.status !== "REVIEWED") {
    throw new Error(`Import plan must be REVIEWED before execution (got ${plan.operator_review.status}).`);
  }
  if (!plan.decision.ready_for_import) {
    throw new Error("Import plan decision.ready_for_import must be true to execute.");
  }
  if (plan.execution.executed) {
    throw new Error("This import plan was already executed.");
  }
  if (!opts.allowHashMismatch && plan.source_file.sha256 !== opts.currentSha256) {
    throw new Error(
      "Source file SHA-256 does not match the plan. Re-run --prepare-import-plan or pass --allow-file-hash-mismatch after intentional file swap."
    );
  }
}

export async function updatePlanAfterExecution(
  planPath: string,
  plan: ImportPlanJson,
  batchId: string
): Promise<void> {
  plan.execution = {
    executed: true,
    import_batch_id: batchId,
    executed_at: new Date().toISOString(),
  };
  plan.operator_review = {
    ...plan.operator_review,
    status: "EXECUTED",
  };
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
}

export async function importPlansTableExists(pool: Pool): Promise<boolean> {
  const r = await pool.query<{ o: string | null }>(`SELECT to_regclass('public.import_plans')::text AS o`);
  return Boolean(r.rows[0]?.o);
}

export async function saveImportPlanToDb(pool: Pool, plan: ImportPlanJson): Promise<void> {
  if (!(await importPlansTableExists(pool))) {
    throw new Error("import_plans table not found. Apply migrations/004_import_plan_guardrails.sql.");
  }
  if (!PLAN_KEY_SAFE.test(plan.plan_key)) {
    throw new Error("Invalid plan_key for database write.");
  }
  const warningsJson = JSON.stringify(plan.decision.warnings);
  const preflightJson = JSON.stringify(plan.preflight);
  const readinessJson = JSON.stringify(plan.readiness);
  const candidateJson = JSON.stringify(plan.candidate_probe);
  const metaJson = JSON.stringify({ plan_version: plan.plan_version });

  await pool.query(
    `INSERT INTO public.import_plans (
      plan_key, project_key, petition_code, petition_name, source_label,
      source_file_name, source_file_hash, source_file_size,
      source_profile_path, source_profile_name, map_path,
      match_source_mode, match_source_table, canonical_table,
      projected_matching_quality, row_count, ready_for_import,
      preflight_json, readiness_json, candidate_probe_json, warnings,
      operator_review_status, operator_reviewed_by, operator_reviewed_at, operator_note,
      executed_import_batch_id, executed_at, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14,
      $15, $16, $17,
      $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb,
      $22, $23, $24::timestamptz, $25,
      $26::uuid, $27::timestamptz, $28::jsonb
    )
    ON CONFLICT (plan_key) DO UPDATE SET
      project_key = EXCLUDED.project_key,
      petition_code = EXCLUDED.petition_code,
      petition_name = EXCLUDED.petition_name,
      source_label = EXCLUDED.source_label,
      source_file_name = EXCLUDED.source_file_name,
      source_file_hash = EXCLUDED.source_file_hash,
      source_file_size = EXCLUDED.source_file_size,
      source_profile_path = EXCLUDED.source_profile_path,
      source_profile_name = EXCLUDED.source_profile_name,
      map_path = EXCLUDED.map_path,
      match_source_mode = EXCLUDED.match_source_mode,
      match_source_table = EXCLUDED.match_source_table,
      canonical_table = EXCLUDED.canonical_table,
      projected_matching_quality = EXCLUDED.projected_matching_quality,
      row_count = EXCLUDED.row_count,
      ready_for_import = EXCLUDED.ready_for_import,
      preflight_json = EXCLUDED.preflight_json,
      readiness_json = EXCLUDED.readiness_json,
      candidate_probe_json = EXCLUDED.candidate_probe_json,
      warnings = EXCLUDED.warnings,
      operator_review_status = EXCLUDED.operator_review_status,
      operator_reviewed_by = EXCLUDED.operator_reviewed_by,
      operator_reviewed_at = EXCLUDED.operator_reviewed_at,
      operator_note = EXCLUDED.operator_note,
      executed_import_batch_id = EXCLUDED.executed_import_batch_id,
      executed_at = EXCLUDED.executed_at,
      metadata = EXCLUDED.metadata,
      updated_at = now()`,
    [
      plan.plan_key,
      plan.project_key,
      plan.petition_code,
      plan.petition_name,
      plan.source_label,
      plan.source_file.name,
      plan.source_file.sha256,
      plan.source_file.size_bytes,
      plan.source_profile.path,
      plan.source_profile.profile_name,
      plan.map.path,
      plan.match_source.mode,
      plan.match_source.table,
      plan.canonical_table,
      plan.decision.projected_matching_quality,
      plan.preflight.row_count,
      plan.decision.ready_for_import,
      preflightJson,
      readinessJson,
      candidateJson,
      warningsJson,
      plan.operator_review.status,
      plan.operator_review.reviewed_by,
      plan.operator_review.reviewed_at,
      plan.operator_review.note,
      plan.execution.import_batch_id,
      plan.execution.executed_at,
      metaJson,
    ]
  );
}

export type ImportPlanListRow = {
  plan_key: string;
  project_key: string;
  petition_code: string;
  source_file_name: string;
  source_file_hash_short: string;
  row_count: number | null;
  ready_for_import: boolean;
  operator_review_status: string;
  executed_import_batch_id: string | null;
  created_at: string;
  executed_at: string | null;
};

export async function listImportPlansFromDb(
  pool: Pool,
  filters: { petitionCode?: string; projectKey?: string; status?: string; limit: number }
): Promise<ImportPlanListRow[]> {
  if (!(await importPlansTableExists(pool))) {
    return [];
  }
  const lim = Math.min(Math.max(filters.limit, 1), 500);
  const conds: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (filters.petitionCode) {
    conds.push(`petition_code = $${i++}`);
    vals.push(filters.petitionCode);
  }
  if (filters.projectKey) {
    conds.push(`project_key = $${i++}`);
    vals.push(filters.projectKey);
  }
  if (filters.status) {
    conds.push(`operator_review_status = $${i++}`);
    vals.push(filters.status);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limitIdx = vals.length + 1;
  vals.push(lim);
  const r = await pool.query<{
    plan_key: string;
    project_key: string;
    petition_code: string;
    source_file_name: string;
    source_file_hash: string;
    row_count: number | null;
    ready_for_import: boolean;
    operator_review_status: string;
    executed_import_batch_id: string | null;
    created_at: Date;
    executed_at: Date | null;
  }>(
    `SELECT plan_key, project_key, petition_code, source_file_name, source_file_hash, row_count,
            ready_for_import, operator_review_status, executed_import_batch_id, created_at, executed_at
     FROM public.import_plans
     ${where}
     ORDER BY created_at DESC
     LIMIT $${limitIdx}`,
    vals
  );
  return r.rows.map((row) => ({
    plan_key: row.plan_key,
    project_key: row.project_key,
    petition_code: row.petition_code,
    source_file_name: row.source_file_name,
    source_file_hash_short: shortHash(row.source_file_hash, 12),
    row_count: row.row_count,
    ready_for_import: row.ready_for_import,
    operator_review_status: row.operator_review_status,
    executed_import_batch_id: row.executed_import_batch_id,
    created_at: row.created_at.toISOString(),
    executed_at: row.executed_at ? row.executed_at.toISOString() : null,
  }));
}

export function inspectImportPlanSummary(plan: ImportPlanJson): Record<string, unknown> {
  return {
    plan_key: plan.plan_key,
    source_file_name: plan.source_file.name,
    source_file_hash_short: shortHash(plan.source_file.sha256, 12),
    petition_code: plan.petition_code,
    petition_name: plan.petition_name,
    row_count: plan.preflight.row_count,
    ready_for_import: plan.decision.ready_for_import,
    projected_matching_quality: plan.decision.projected_matching_quality,
    blocking_reasons: plan.decision.blocking_reasons,
    warnings_count: plan.decision.warnings.length,
    operator_review_status: plan.operator_review.status,
    executed: plan.execution.executed,
    import_batch_id: plan.execution.import_batch_id,
  };
}

export async function executeImportPlanFromDisk(opts: {
  planPath: string;
  allowHashMismatch: boolean;
  savePlanDb: boolean;
  createdBy: string | null;
  chunkSize: number;
  /** CLI override: force auto-create initiative on execute even if plan flag is false. */
  autoCreateInitiative?: boolean;
  initiativeScope?: string | null;
  reportingGeo?: string | null;
  targetSignatureCount?: number | null;
  initiativeNotes?: string | null;
}): Promise<Awaited<ReturnType<typeof runFullImport>>> {
  const planPath = resolve(opts.planPath);
  const plan = await readImportPlan(planPath);
  if (!plan.source_profile.path) {
    throw new Error("Plan is missing source_profile.path.");
  }
  const profilePath = resolve(process.cwd(), plan.source_profile.path);
  const filePath = resolve(process.cwd(), plan.source_file.path);

  const currentSha = await computeFileSha256(filePath);
  validatePlanForExecution(plan, { currentSha256: currentSha, allowHashMismatch: opts.allowHashMismatch });

  const mapFile = await loadHeaderMapFile(profilePath);

  const snap = plan.initiative_snapshot;
  const autoCreate = opts.autoCreateInitiative === true || plan.auto_create_initiative === true;
  const buf = await readFile(filePath);
  const sheet = parseVoterBuffer(buf, filePath, parseFileOptionsFromMap(mapFile));
  const pf = runPreflightOnSheet(sheet, filePath, mapFile);
  if (pf.row_count !== plan.preflight.row_count) {
    throw new Error(
      `Preflight row count mismatch: plan had ${plan.preflight.row_count}, current file has ${pf.row_count}.`
    );
  }
  const expectedProfile = plan.source_profile.profile_name;
  if (expectedProfile != null && mapFile.profileName !== expectedProfile) {
    throw new Error("Active profile name does not match the import plan.");
  }

  const envProject = process.env.VFM_PROJECT_KEY?.trim();
  if (envProject && envProject !== plan.project_key) {
    throw new Error(`VFM_PROJECT_KEY (${envProject}) does not match plan project_key (${plan.project_key}).`);
  }

  const petitionFromEnv = process.env.VFM_PETITION_CODE?.trim();
  if (petitionFromEnv && petitionFromEnv !== plan.petition_code) {
    throw new Error(`VFM_PETITION_CODE does not match plan petition_code.`);
  }

  const petitionNameEnv = process.env.VFM_PETITION_NAME?.trim();
  if (petitionNameEnv && petitionNameEnv !== plan.petition_name) {
    throw new Error(`VFM_PETITION_NAME does not match plan petition_name.`);
  }

  const result = await runFullImport({
    filePath,
    mapPath: profilePath,
    mapFile,
    petitionCode: plan.petition_code,
    petitionName: plan.petition_name,
    projectKey: plan.project_key,
    sourceLabel: plan.source_label,
    createdBy: opts.createdBy,
    chunkSize: opts.chunkSize,
    autoCreateInitiative: autoCreate,
    initiativeScope: opts.initiativeScope ?? snap?.initiative_scope ?? null,
    reportingGeo: opts.reportingGeo ?? snap?.reporting_geo ?? null,
    targetSignatureCount: opts.targetSignatureCount ?? snap?.target_signature_count ?? null,
    initiativeNotes: opts.initiativeNotes ?? null,
  });

  plan.execution = {
    executed: true,
    import_batch_id: result.batch_id,
    executed_at: new Date().toISOString(),
  };
  plan.operator_review = { ...plan.operator_review, status: "EXECUTED" };
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

  if (opts.savePlanDb) {
    const pool = createPool();
    try {
      await saveImportPlanToDb(pool, plan);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  return result;
}
