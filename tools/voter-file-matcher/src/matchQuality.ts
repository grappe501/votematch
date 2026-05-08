import type { NormalizedRowJson, QaFlag } from "./types.js";

/** QA flags that disqualify a row from being treated as a slam-dunk auto match. */
export const SEVERE_QA_FLAGS_FOR_SLAM: ReadonlySet<QaFlag> = new Set([
  "MISSING_FIRST_NAME",
  "MISSING_LAST_NAME",
  "MISSING_ADDRESS",
  "INVALID_BIRTH_DATE",
  "INVALID_BIRTH_YEAR",
  "INVALID_ZIP",
  "FUTURE_SIGNED_AT",
]);

/** Identity QA that forces operator review (matches initiative_review_queue_80 SQL). */
export const SEVERE_QA_FLAGS_FOR_REVIEW_QUEUE: ReadonlySet<QaFlag> = new Set([
  "MISSING_FIRST_NAME",
  "MISSING_LAST_NAME",
  "MISSING_ADDRESS",
  "INVALID_BIRTH_DATE",
  "INVALID_BIRTH_YEAR",
  "INVALID_ZIP",
]);

export function hasSevereQaForReviewQueue(normalized: NormalizedRowJson): boolean {
  const flags = Array.isArray(normalized._qa_flags) ? normalized._qa_flags : [];
  return flags.some((f) => SEVERE_QA_FLAGS_FOR_REVIEW_QUEUE.has(f));
}

export function isWeakMatchMethod(matchMethod: string | null | undefined): boolean {
  const m = (matchMethod ?? "").toLowerCase();
  return m.includes("weak") || m.includes("tier5");
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export function parseQaFlagsJson(raw: unknown): QaFlag[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.filter((x): x is QaFlag => typeof x === "string");
  }
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw) as unknown;
      return Array.isArray(j) ? j.filter((x): x is QaFlag => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

export type SlamDunkMatchFields = {
  match_status: string;
  candidate_count: number | string | null | undefined;
  voter_id: string | null | undefined;
  match_method: string | null | undefined;
  match_confidence: string | number | null | undefined;
  /** Integer 0–100 from migration 006; when 100 with clean QA, treated as slam-dunk identity. */
  match_confidence_pct?: number | string | null | undefined;
  qa_flags?: unknown;
};

function intPct(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

export function isSlamDunkMatch(row: SlamDunkMatchFields): boolean {
  if (row.match_status !== "MATCHED") return false;
  const cc = Number(row.candidate_count ?? 0);
  if (!Number.isFinite(cc) || cc !== 1) return false;
  const vid = (row.voter_id ?? "").trim();
  if (!vid) return false;
  if (isWeakMatchMethod(row.match_method)) return false;
  const flags = parseQaFlagsJson(row.qa_flags);
  for (const f of flags) {
    if (SEVERE_QA_FLAGS_FOR_SLAM.has(f)) return false;
  }
  const pct = intPct(row.match_confidence_pct);
  if (pct != null && pct >= 100) return true;
  const conf = numOrNull(row.match_confidence);
  if (conf != null && conf < 0.95) return false;
  return true;
}

/** Row needs human review (independent of review_status). */
export function rowNeedsReviewByOutcome(row: SlamDunkMatchFields): boolean {
  const st = row.match_status;
  if (st === "NOT_FOUND" || st === "MULTIPLE_MATCHES" || st === "WEAK_MATCH" || st === "ERROR") return true;
  if (st === "MATCHED") return !isSlamDunkMatch(row);
  return true;
}

/** Matches `batch_review_queue_enriched` semantics (open review + non-slam or bad status). */
export function rowNeedsOperatorQueue(reviewStatus: string, row: SlamDunkMatchFields): boolean {
  if (reviewStatus !== "UNREVIEWED" && reviewStatus !== "NEEDS_MORE_INFO") return false;
  const st = row.match_status;
  if (st === "NOT_FOUND" || st === "MULTIPLE_MATCHES" || st === "WEAK_MATCH" || st === "ERROR") return true;
  if (st === "MATCHED") return !isSlamDunkMatch(row);
  return false;
}

export function problemTagsForRow(
  row: SlamDunkMatchFields & {
    normalized?: NormalizedRowJson | null;
    notes?: string | null;
    signature_voter_ward?: string | null;
  }
): string[] {
  const tags = new Set<string>();
  const st = row.match_status;
  if (st === "NOT_FOUND") tags.add("NOT_FOUND");
  if (st === "MULTIPLE_MATCHES") tags.add("MULTIPLE_MATCHES");
  if (st === "WEAK_MATCH") tags.add("WEAK_MATCH");
  if (st === "ERROR") tags.add("ERROR");

  const flags = parseQaFlagsJson(row.qa_flags);
  for (const f of flags) {
    tags.add(f);
  }

  const n = row.normalized;
  if (n) {
    if (!n.first_name?.trim()) tags.add("MISSING_FIRST_NAME");
    if (!n.last_name?.trim()) tags.add("MISSING_LAST_NAME");
    if (!(n.address || n.address_line_display)?.trim()) tags.add("MISSING_ADDRESS");
    if (!n.city?.trim()) tags.add("MISSING_CITY");
    if (!n.state?.trim()) tags.add("MISSING_STATE");
    if (!n.zip?.trim()) tags.add("MISSING_ZIP");
    if (n.notes?.trim()) tags.add("HAS_NOTES");
  }

  if (st === "MATCHED") {
    const conf = numOrNull(row.match_confidence);
    if (conf != null && conf < 0.95) tags.add("LOW_CONFIDENCE_MATCH");
    if (flags.some((f) => SEVERE_QA_FLAGS_FOR_SLAM.has(f))) tags.add("MATCHED_BUT_HAS_SEVERE_QA");
  }

  if (st === "MATCHED" && isSlamDunkMatch(row)) {
    const w = (row.signature_voter_ward ?? "").trim();
    if (!w) tags.add("MISSING_WARD_SOURCE");
  }

  return [...tags].sort();
}

export function recommendedActionForProblem(problem: string): string {
  const m: Record<string, string> = {
    NOT_FOUND: "Search by last name and address; check spelling; verify city/ZIP.",
    MULTIPLE_MATCHES: "Open candidates and select correct voter manually.",
    WEAK_MATCH: "Verify DOB/address before approval.",
    ERROR: "Inspect error notes and raw row; fix source data or map.",
    MISSING_ADDRESS: "Check original sheet or signer record.",
    MISSING_FIRST_NAME: "Recover first name from notes or source file.",
    MISSING_LAST_NAME: "Recover last name from notes or source file.",
    MISSING_CITY: "Confirm city against voter registration address.",
    MISSING_STATE: "Confirm state on the sheet.",
    MISSING_ZIP: "Confirm ZIP on the sheet.",
    INVALID_ZIP: "Correct ZIP format to 5 digits where possible.",
    INVALID_BIRTH_DATE: "Verify birth date against voter file.",
    INVALID_BIRTH_YEAR: "Verify birth year against voter file.",
    INVALID_SIGNED_AT: "Correct signed date on the sheet.",
    FUTURE_SIGNED_AT: "Correct signed date; remove future dates.",
    NON_JACKSONVILLE_CITY: "Verify jurisdiction and address for Duval/Jacksonville.",
    HAS_NOTES: "Review NOTES column before approval.",
    POSSIBLE_DUPLICATE_WITHIN_FILE: "Compare duplicate rows and keep one canonical signer line.",
    MISSING_WARD_SOURCE:
      "Expose ward or district on VFM_MATCH_SOURCE_TABLE (or voter_petition_signatures) for ward reporting.",
    LOW_CONFIDENCE_MATCH: "Confirm identity with additional fields before approval.",
    MATCHED_BUT_HAS_SEVERE_QA: "Treat as manual review; do not rely on auto-match alone.",
  };
  return m[problem] ?? "Review row details and voter file side by side.";
}
