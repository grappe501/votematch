import type { NormalizedRowJson } from "./types.js";
import type { VoterSearchCandidate } from "./reviewSearch.js";
import { evaluateJurisdictionStatus, zip5Equal, type JurisdictionPetitionContext } from "./jurisdiction.js";
import { normalizeCity, normalizeName, normalizeZip5 } from "./normalize.js";

export type RankedCandidate = VoterSearchCandidate & {
  candidate_rank: number;
  jurisdiction_status: ReturnType<typeof evaluateJurisdictionStatus>;
};

function parseYear(s: string | null | undefined): number | null {
  if (!s?.trim()) return null;
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function stripIsoDate(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  return t.length >= 10 ? t.slice(0, 10) : t;
}

/**
 * Scores 0–100 for review UI; applies jurisdiction penalty and sets per-candidate jurisdiction flag.
 */
export function rankCandidatesForRow(
  normalized: NormalizedRowJson,
  candidates: VoterSearchCandidate[],
  petition: JurisdictionPetitionContext
): RankedCandidate[] {
  const fn = normalizeName(normalized.first_name ?? "");
  const ln = normalizeName(normalized.last_name ?? "");
  const bd = (normalized.birth_date ?? "").trim();
  const by = normalized.birth_year ?? null;
  const addr = (normalized.address ?? normalized.address_line_display ?? "").trim();
  const city = (normalized.city ?? "").trim();
  const zip = normalizeZip5(normalized.zip ?? "");
  const st = (normalized.state ?? "").trim();

  const ranked: RankedCandidate[] = [];

  for (const c of candidates) {
    const cfn = normalizeName(c.first_name);
    const cln = normalizeName(c.last_name);
    const cbd = stripIsoDate(c.birth_date);
    const cby = parseYear(c.birth_year);
    const caddr = (c.address ?? "").trim();
    const ccity = (c.city ?? "").trim();
    const czip = normalizeZip5(c.zip5 ?? "");
    const cst = (c.state ?? "").trim();

    let score = 0;
    const reasons: string[] = [];

    if (c.voter_id?.trim() && normalized.voter_id?.trim() && c.voter_id.trim() === normalized.voter_id.trim()) {
      score = 100;
      reasons.push("voter_id_exact");
    } else if (fn && ln && bd && cbd && fn === cfn && ln === cln && bd === cbd) {
      score = 98;
      reasons.push("name_birth_date_exact");
    } else if (fn && ln && by != null && cby != null && addr && caddr && zip && czip) {
      if (fn === cfn && ln === cln && by === cby && addr === caddr && zip === czip) {
        score = 95;
        reasons.push("name_yob_address_zip");
      } else if (fn === cfn && ln === cln && by === cby) {
        score = 88;
        reasons.push("name_yob_partial_loc");
      }
    } else if (fn && ln && by != null && cby != null && ccity && city && zip && czip) {
      if (fn === cfn && ln === cln && by === cby && normalizeCity(city) === normalizeCity(ccity) && zip === czip) {
        score = 90;
        reasons.push("name_yob_city_zip");
      }
    }

    if (score === 0 && ln && cln && ln === cln) {
      const num = addr.match(/^\s*(\d+)/)?.[1] ?? "";
      const cnum = caddr.match(/^\s*(\d+)/)?.[1] ?? "";
      if (num && cnum && num === cnum && city && ccity && normalizeCity(city) === normalizeCity(ccity)) {
        score = 80;
        reasons.push("last_streetnum_city");
      } else if (zip && czip && zip === czip) {
        score = 70;
        reasons.push("last_zip");
      } else if (city && ccity && normalizeCity(city) === normalizeCity(ccity)) {
        score = 60;
        reasons.push("last_city");
      } else if (fn && cfn && fn === cfn && ln === cln) {
        score = 45;
        reasons.push("name_prefix");
      }
    }

    if (by == null && cby == null && score > 0) {
      score = Math.max(0, score - 5);
      reasons.push("missing_birth_penalty");
    } else if (by == null || cby == null) {
      score = Math.max(0, score - 10);
      reasons.push("missing_birth_data");
    }

    if (addr && caddr && addr !== caddr) {
      score = Math.max(0, score - 10);
      reasons.push("address_mismatch");
    }
    if (zip && czip && zip !== czip) {
      score = Math.max(0, score - 8);
      reasons.push("zip_mismatch");
    }

    const jStatus = evaluateJurisdictionStatus(petition, {
      city: c.city,
      county: c.county,
      state: c.state,
      district: c.ward || c.precinct,
    });
    if (jStatus === "OUT_OF_JURISDICTION") {
      score = Math.max(0, score - 20);
      reasons.push("out_of_jurisdiction_penalty");
    }

    ranked.push({
      ...c,
      candidate_score: Math.max(0, Math.min(100, Math.round(score))),
      candidate_reason: reasons.join("|") || c.candidate_reason || "ranked",
      candidate_rank: 0,
      jurisdiction_status: jStatus,
    });
  }

  ranked.sort((a, b) => b.candidate_score - a.candidate_score);
  let r = 1;
  for (const x of ranked) {
    x.candidate_rank = r++;
  }
  return ranked;
}
