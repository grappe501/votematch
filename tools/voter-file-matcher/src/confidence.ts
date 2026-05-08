import type { MatchStatus, NormalizedRowJson, QaFlag } from "./types.js";

const SEVERE_IDENTITY_QA: ReadonlySet<QaFlag> = new Set([
  "MISSING_FIRST_NAME",
  "MISSING_LAST_NAME",
  "MISSING_ADDRESS",
  "INVALID_BIRTH_DATE",
  "INVALID_BIRTH_YEAR",
  "INVALID_ZIP",
]);

function flags(n: NormalizedRowJson): QaFlag[] {
  return Array.isArray(n._qa_flags) ? n._qa_flags : [];
}

function qaPenalty(flagsArr: QaFlag[]): number {
  let p = 0;
  for (const f of flagsArr) {
    if (SEVERE_IDENTITY_QA.has(f)) p += 12;
  }
  return Math.min(30, p);
}

function notesPenalty(n: NormalizedRowJson): number {
  return n.notes?.trim() ? 5 : 0;
}

function hasNameParts(n: NormalizedRowJson): boolean {
  return Boolean(n.first_name?.trim() && n.last_name?.trim());
}

function hasAddressSignal(n: NormalizedRowJson): boolean {
  return Boolean((n.address ?? n.address_line_display)?.trim() || n.zip?.trim());
}

function hasCityZip(n: NormalizedRowJson): boolean {
  return Boolean(n.city?.trim() && n.zip?.trim());
}

function hasDob(n: NormalizedRowJson): boolean {
  return Boolean(n.birth_date?.trim());
}

function hasBirthYear(n: NormalizedRowJson): boolean {
  return n.birth_year != null && Number.isFinite(n.birth_year);
}

function methodTier(m: string | null | undefined): string {
  const x = (m ?? "").toLowerCase();
  if (x.includes("tier1") || x.includes("voter_id")) return "t1";
  if (x.includes("tier2") || x.includes("birth_date")) return "t2";
  if (x.includes("tier3") || x.includes("yob_address") || x.includes("birth_year")) return "t3";
  if (x.includes("tier4")) return "t4";
  if (x.includes("tier5") || x.includes("weak")) return "t5";
  return "unknown";
}

export type MatchConfidenceInput = {
  status: MatchStatus;
  matchMethod: string | null;
  matchConfidence: number | null;
  candidateCount: number;
  voterId: string | null;
  normalized: NormalizedRowJson;
};

/**
 * Integer 0–100 identity-match confidence (not legal validity of a signature).
 */
export function calculateMatchConfidencePct(input: MatchConfidenceInput): number {
  const n = input.normalized;
  const f = flags(n);
  const pen = qaPenalty(f) + notesPenalty(n);
  const tier = methodTier(input.matchMethod);

  const applyCaps = (raw: number): number => {
    let v = Math.max(0, Math.min(100, Math.round(raw)));
    if (input.status === "MULTIPLE_MATCHES") v = Math.min(50, v);
    if (input.status === "WEAK_MATCH") v = Math.min(65, v);
    return v;
  };

  if (input.status === "ERROR") return 0;

  if (input.status === "NOT_FOUND") {
    if (hasNameParts(n) || (n.last_name?.trim() && hasAddressSignal(n))) return applyCaps(15 - pen);
    return 0;
  }

  if (input.status === "MULTIPLE_MATCHES") {
    const strongTier = tier === "t1" || tier === "t2" || tier === "t3" || tier === "t4";
    const base = strongTier ? 50 : 35;
    return applyCaps(base - pen);
  }

  if (input.status === "WEAK_MATCH") {
    return applyCaps(65 - pen);
  }

  if (input.status !== "MATCHED" || !input.voterId?.trim() || input.candidateCount !== 1) {
    return applyCaps(0);
  }

  let base = 75;
  if (tier === "t1") {
    base = 100;
  } else if (tier === "t2") {
    if (hasDob(n) && hasAddressSignal(n)) base = 100;
    else if (hasDob(n) && hasCityZip(n)) base = 95;
    else base = 95;
  } else if (tier === "t3") {
    base = 90;
  } else if (tier === "t4") {
    base = 85;
  } else if (tier === "t5") {
    base = 65;
  } else {
    const mc = input.matchConfidence;
    if (mc != null && mc >= 0.95) base = 90;
    else if (mc != null && mc >= 0.85) base = 85;
    else if (mc != null && mc >= 0.5) base = 75;
    else base = 70;
  }

  if (tier !== "t1" && !hasBirthYear(n) && !hasDob(n) && hasAddressSignal(n)) {
    base = Math.min(base, 75);
  }
  if (tier === "t5" || (input.matchMethod ?? "").toLowerCase().includes("weak")) {
    base = Math.min(base, 65);
  }

  return applyCaps(base - pen);
}

/** Manual reviewer attach after validated voter_id — high confidence by policy. */
export function manualApprovalConfidencePct(): number {
  return 100;
}

export function buildConfidenceReason(input: MatchConfidenceInput, pct: number): string {
  const parts: string[] = [];
  parts.push(`status=${input.status}`);
  if (input.matchMethod) parts.push(`method=${input.matchMethod}`);
  if (input.candidateCount > 1) parts.push(`candidates=${input.candidateCount}`);
  const f = flags(input.normalized);
  if (f.length) parts.push(`qa=${f.join("|")}`);
  parts.push(`pct=${pct}`);
  return parts.join("; ");
}

export function searchPriorityFromConfidence(
  pct: number | null | undefined,
  matchStatus: string,
  normalized: NormalizedRowJson
): "HIGH" | "MEDIUM" | "LOW" | "BLOCKED" {
  const p = pct ?? 0;
  if (!normalized.first_name?.trim() && !normalized.last_name?.trim()) return "BLOCKED";
  if (matchStatus === "MULTIPLE_MATCHES" || matchStatus === "WEAK_MATCH") return "HIGH";
  if (p >= 50 && p <= 74) return "HIGH";
  if (p >= 15 && p <= 49) return "MEDIUM";
  if (p === 0) return "LOW";
  return "LOW";
}
