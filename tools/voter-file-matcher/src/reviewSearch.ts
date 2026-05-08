import type { Pool } from "pg";
import type { BatchSignatureReportRow } from "./reporting.js";
import { loadBatchSignatureReportRows } from "./reporting.js";
import {
  assertVoterExistsInMatchSourceOrCanonical,
  fetchVoterGeoForVoterId,
  readMatchSourceTableEnv,
} from "./matchSource.js";
import type { CanonicalColumnMap, NormalizedRowJson } from "./types.js";
import { colExpr, fetchTableColumnNames, qualifiedTableSql } from "./db.js";
import { normalizeName, normalizeCity, normalizeZip5 } from "./normalize.js";

export type VoterSearchCandidate = {
  voter_id: string;
  first_name: string;
  last_name: string;
  birth_year: string;
  birth_date: string;
  address: string;
  city: string;
  state: string;
  zip5: string;
  ward: string;
  precinct: string;
  candidate_reason: string;
  candidate_score: number;
};

function hasCol(cols: Set<string>, name: string): boolean {
  if (cols.has(name)) return true;
  const low = name.toLowerCase();
  for (const c of cols) {
    if (c.toLowerCase() === low) return true;
  }
  return false;
}

function pickCol(cols: Set<string>, preferred: string[]): string | null {
  for (const p of preferred) {
    if (hasCol(cols, p)) {
      for (const c of cols) {
        if (c.toLowerCase() === p.toLowerCase()) return c;
      }
    }
  }
  return null;
}

async function resolveSearchTableQualified(): Promise<{ table: string; mode: "match_source" | "canonical" }> {
  const ms = readMatchSourceTableEnv()?.trim();
  if (ms) return { table: ms, mode: "match_source" };
  const ct = process.env.VFM_CANONICAL_TABLE?.trim();
  if (!ct) throw new Error("Set VFM_MATCH_SOURCE_TABLE or VFM_CANONICAL_TABLE for voter search.");
  return { table: ct, mode: "canonical" };
}

function streetNumber(addr: string): string {
  const m = addr.trim().match(/^(\d+)/);
  return m?.[1] ?? "";
}

async function runLimitedQuery(
  pool: Pool,
  sql: string,
  params: unknown[],
  limit: number,
  reason: string,
  score: number,
  out: Map<string, VoterSearchCandidate>
): Promise<void> {
  const lim = Math.max(1, Math.min(100, limit));
  const limParam = params.length + 1;
  const r = await pool.query<Record<string, unknown>>(`${sql} LIMIT $${limParam}`, [...params, lim]);
  for (const row of r.rows) {
    const vid = String(row.voter_id ?? "").trim();
    if (!vid || out.has(vid)) continue;
    out.set(vid, {
      voter_id: vid,
      first_name: String(row.first_name ?? ""),
      last_name: String(row.last_name ?? ""),
      birth_year: String(row.birth_year ?? ""),
      birth_date: String(row.birth_date ?? ""),
      address: String(row.address ?? ""),
      city: String(row.city ?? ""),
      state: String(row.state ?? ""),
      zip5: String(row.zip5 ?? ""),
      ward: String(row.ward ?? ""),
      precinct: String(row.precinct ?? ""),
      candidate_reason: reason,
      candidate_score: score,
    });
  }
}

/** Next row for operator review (prioritized order). */
export async function fetchNextReviewRow(pool: Pool, batchId: string): Promise<BatchSignatureReportRow | null> {
  const r = await pool.query<BatchSignatureReportRow>(
    `SELECT *
     FROM batch_review_queue_enriched
     WHERE import_batch_id = $1::uuid
     ORDER BY
       CASE match_status
         WHEN 'MULTIPLE_MATCHES' THEN 1
         WHEN 'WEAK_MATCH' THEN 2
         WHEN 'NOT_FOUND' THEN 3
         WHEN 'ERROR' THEN 4
         ELSE 5
       END,
       row_number ASC
     LIMIT 1`,
    [batchId]
  );
  return r.rows[0] ?? null;
}

export async function searchVotersForRow(
  pool: Pool,
  opts: {
    batchId: string;
    rowNumber: number;
    limit?: number;
    lastName?: string;
    firstName?: string;
    city?: string;
    zip?: string;
    address?: string;
    includeAddress?: boolean;
    canonicalTableQualified: string;
    cols: CanonicalColumnMap;
  }
): Promise<{ normalized: NormalizedRowJson; candidates: VoterSearchCandidate[] }> {
  const rows = await loadBatchSignatureReportRows(pool, opts.batchId);
  const row = rows.find((x) => x.row_number === opts.rowNumber);
  if (!row) throw new Error(`Row ${opts.rowNumber} not found in batch ${opts.batchId}`);

  const n = { ...row.normalized_json };
  if (opts.lastName?.trim()) n.last_name = opts.lastName.trim();
  if (opts.firstName?.trim()) n.first_name = opts.firstName.trim();
  if (opts.city?.trim()) n.city = opts.city.trim();
  if (opts.zip?.trim()) n.zip = opts.zip.trim();
  if (opts.address?.trim()) n.address_line_display = opts.address.trim();

  const limit = opts.limit ?? 20;
  const { table, mode } = await resolveSearchTableQualified();
  const qt = qualifiedTableSql(table);
  const colsDb = await fetchTableColumnNames(pool, table);
  const candidates = new Map<string, VoterSearchCandidate>();

  if (mode === "match_source") {
    const ln = pickCol(colsDb, ["last_name_norm", "last_name"]);
    const fn = pickCol(colsDb, ["first_name_norm", "first_name"]);
    const cn = pickCol(colsDb, ["city_norm", "city"]);
    const z5 = pickCol(colsDb, ["zip5", "zip"]);
    const an = pickCol(colsDb, ["address_norm", "address"]);
    const vid = pickCol(colsDb, ["voter_id"]);
    const by = pickCol(colsDb, ["birth_year"]);
    const bd = pickCol(colsDb, ["birth_date"]);
    const st = pickCol(colsDb, ["state"]);
    const wcol = pickCol(colsDb, ["ward", "ward_norm"]);
    const pcol = pickCol(colsDb, ["precinct", "precinct_norm"]);
    if (!ln || !vid) throw new Error("Match source must expose voter_id and last name column for search.");

    const lnVal = normalizeName(n.last_name ?? "");
    const cnVal = normalizeCity(n.city ?? "");
    const zVal = normalizeZip5(n.zip ?? "");
    const fnVal = normalizeName(n.first_name ?? "");
    const addrSrc = (opts.includeAddress === false ? "" : n.address_line_display ?? n.address ?? "").trim();
    const anVal = addrSrc ? normalizeName(addrSrc.replace(/[^a-zA-Z0-9]/g, "")) : "";
    const num = streetNumber(addrSrc || opts.address?.trim() || "");

    const baseSelect = [
      `${colExpr(qt, vid)}::text AS voter_id`,
      fn ? `${colExpr(qt, fn)}::text AS first_name` : `''::text AS first_name`,
      `${colExpr(qt, ln)}::text AS last_name`,
      by ? `${colExpr(qt, by)}::text AS birth_year` : `''::text AS birth_year`,
      bd ? `${colExpr(qt, bd)}::text AS birth_date` : `''::text AS birth_date`,
      an ? `${colExpr(qt, an)}::text AS address` : `''::text AS address`,
      cn ? `${colExpr(qt, cn)}::text AS city` : `''::text AS city`,
      st ? `${colExpr(qt, st)}::text AS state` : `''::text AS state`,
      z5 ? `${colExpr(qt, z5)}::text AS zip5` : `''::text AS zip5`,
      wcol ? `${colExpr(qt, wcol)}::text AS ward` : `''::text AS ward`,
      pcol ? `${colExpr(qt, pcol)}::text AS precinct` : `''::text AS precinct`,
    ].join(", ");

    if (lnVal && cnVal && cn) {
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qt}
         WHERE ${colExpr(qt, ln)} = $1 AND ${colExpr(qt, cn)} = $2`,
        [lnVal, cnVal],
        limit,
        "last_name_norm + city_norm",
        100,
        candidates
      );
    }
    if (lnVal && zVal && z5) {
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qt}
         WHERE ${colExpr(qt, ln)} = $1 AND ${colExpr(qt, z5)} = $2`,
        [lnVal, zVal],
        limit,
        "last_name_norm + zip5",
        90,
        candidates
      );
    }
    if (lnVal && num && an) {
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qt}
         WHERE ${colExpr(qt, ln)} = $1 AND ${colExpr(qt, an)}::text LIKE $2`,
        [lnVal, `${num}%`],
        limit,
        "last_name_norm + address number prefix",
        80,
        candidates
      );
    }
    if (fnVal && lnVal && cnVal && fn && cn) {
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qt}
         WHERE ${colExpr(qt, ln)} = $1 AND ${colExpr(qt, fn)}::text LIKE $2 AND ${colExpr(qt, cn)} = $3`,
        [lnVal, `${fnVal}%`, cnVal],
        limit,
        "first_name prefix + last_name + city",
        70,
        candidates
      );
    }
    if (anVal && cnVal && an && cn) {
      const token = anVal.slice(0, Math.min(12, anVal.length));
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qt}
         WHERE ${colExpr(qt, an)}::text LIKE $1 AND ${colExpr(qt, cn)} = $2`,
        [`%${token}%`, cnVal],
        limit,
        "address token + city",
        60,
        candidates
      );
    }
  } else {
    const qtC = qualifiedTableSql(opts.canonicalTableQualified);
    const idCol = opts.cols.id;
    const fnC = opts.cols.first_name;
    const lnC = opts.cols.last_name;
    const cityC = opts.cols.city;
    const zipC = opts.cols.zip;
    const addrC = opts.cols.address;
    const byC = opts.cols.birth_year;
    const bdC = opts.cols.birth_date;

    const baseSelect = [
      `${colExpr(qtC, idCol)}::text AS voter_id`,
      `${colExpr(qtC, fnC)}::text AS first_name`,
      `${colExpr(qtC, lnC)}::text AS last_name`,
      byC ? `${colExpr(qtC, byC)}::text AS birth_year` : `''::text AS birth_year`,
      bdC ? `${colExpr(qtC, bdC)}::text AS birth_date` : `''::text AS birth_date`,
      addrC ? `${colExpr(qtC, addrC)}::text AS address` : `''::text AS address`,
      cityC ? `${colExpr(qtC, cityC)}::text AS city` : `''::text AS city`,
      `''::text AS state`,
      zipC ? `${colExpr(qtC, zipC)}::text AS zip5` : `''::text AS zip5`,
      `''::text AS ward`,
      `''::text AS precinct`,
    ].join(", ");

    const ln = (n.last_name ?? "").trim();
    const fn = (n.first_name ?? "").trim();
    const city = (n.city ?? "").trim();
    const zip = (n.zip ?? "").trim().replace(/\D/g, "").slice(0, 5);
    const addr = (opts.includeAddress === false ? "" : n.address_line_display ?? n.address ?? "").trim();
    const num = streetNumber(addr);

    if (ln && city && cityC) {
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qtC}
         WHERE lower(btrim(${colExpr(qtC, lnC)}::text)) = lower(btrim($1::text))
           AND lower(btrim(${colExpr(qtC, cityC)}::text)) = lower(btrim($2::text))`,
        [ln, city],
        limit,
        "last_name + city",
        100,
        candidates
      );
    }
    if (ln && zip && zipC) {
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qtC}
         WHERE lower(btrim(${colExpr(qtC, lnC)}::text)) = lower(btrim($1::text))
           AND regexp_replace(btrim(${colExpr(qtC, zipC)}::text), '[^0-9]', '', 'g') LIKE $2 || '%'`,
        [ln, zip],
        limit,
        "last_name + zip",
        90,
        candidates
      );
    }
    if (ln && num && addrC) {
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qtC}
         WHERE lower(btrim(${colExpr(qtC, lnC)}::text)) = lower(btrim($1::text))
           AND ${colExpr(qtC, addrC)}::text LIKE $2`,
        [ln, `${num}%`],
        limit,
        "last_name + address number",
        80,
        candidates
      );
    }
    if (fn && ln && city && cityC) {
      await runLimitedQuery(
        pool,
        `SELECT ${baseSelect}
         FROM ${qtC}
         WHERE lower(btrim(${colExpr(qtC, lnC)}::text)) = lower(btrim($1::text))
           AND lower(btrim(${colExpr(qtC, fnC)}::text)) LIKE lower($2::text) || '%'
           AND lower(btrim(${colExpr(qtC, cityC)}::text)) = lower(btrim($3::text))`,
        [ln, fn, city],
        limit,
        "first prefix + last + city",
        70,
        candidates
      );
    }
  }

  const sorted = [...candidates.values()].sort((a, b) => b.candidate_score - a.candidate_score);
  return { normalized: n, candidates: sorted.slice(0, limit) };
}

export async function assertVoterInResolvedSource(
  pool: Pool,
  opts: { voterId: string; canonicalTableQualified: string; cols: CanonicalColumnMap }
): Promise<void> {
  const c = await pool.connect();
  try {
    await assertVoterExistsInMatchSourceOrCanonical(c, {
      voterId: opts.voterId,
      canonicalTableQualified: opts.canonicalTableQualified,
      cols: opts.cols,
    });
  } finally {
    c.release();
  }
}

export async function fetchGeoForApprove(
  pool: Pool,
  opts: { voterId: string; canonicalTableQualified: string }
): Promise<{ voterWard: string | null; voterPrecinct: string | null; voterDistrict: string | null }> {
  const geoTable = readMatchSourceTableEnv()?.trim() || opts.canonicalTableQualified?.trim() || "";
  if (!geoTable) return { voterWard: null, voterPrecinct: null, voterDistrict: null };
  const c = await pool.connect();
  try {
    const g = await fetchVoterGeoForVoterId(c, { qualifiedTable: geoTable, voterId: opts.voterId });
    return { voterWard: g.voter_ward, voterPrecinct: g.voter_precinct, voterDistrict: g.voter_district };
  } finally {
    c.release();
  }
}
