import { normalizeCity, normalizeStateUpper, normalizeZip5 } from "./normalize.js";

export type JurisdictionPetitionContext = {
  initiative_scope?: string | null;
  jurisdiction_type?: string | null;
  jurisdiction_city?: string | null;
  jurisdiction_county?: string | null;
  jurisdiction_state?: string | null;
};

export type JurisdictionLocationInput = {
  city?: string | null;
  county?: string | null;
  state?: string | null;
  district?: string | null;
};

export type JurisdictionStatusResult =
  | "IN_JURISDICTION"
  | "OUT_OF_JURISDICTION"
  | "UNKNOWN_JURISDICTION"
  | "NOT_CHECKED";

/**
 * Compares a voter or candidate location to the petition jurisdiction metadata.
 * Does not hardcode any municipality; uses `petition` fields only.
 */
export function evaluateJurisdictionStatus(
  petition: JurisdictionPetitionContext,
  loc: JurisdictionLocationInput
): JurisdictionStatusResult {
  const scope = (petition.initiative_scope ?? petition.jurisdiction_type ?? "").toUpperCase();
  const jt = (petition.jurisdiction_type ?? "").toUpperCase();

  const city = (loc.city ?? "").trim();
  const county = (loc.county ?? "").trim();
  const state = normalizeStateUpper(loc.state ?? "") ?? "";
  const district = (loc.district ?? "").trim();

  const jCity = (petition.jurisdiction_city ?? "").trim();
  const jCounty = (petition.jurisdiction_county ?? "").trim();
  const jState = normalizeStateUpper(petition.jurisdiction_state ?? "") ?? "";

  const effective = jt || scope;

  if (!effective || effective === "OTHER") {
    return "UNKNOWN_JURISDICTION";
  }

  if (effective === "CITY" || (scope === "CITY" && effective !== "COUNTY" && effective !== "STATEWIDE")) {
    if (!jCity && !jState) return "UNKNOWN_JURISDICTION";
    if (!city || !state) return "UNKNOWN_JURISDICTION";
    const nc = normalizeCity(city);
    const nj = normalizeCity(jCity);
    if (nj && nc && nj === nc && state === jState) return "IN_JURISDICTION";
    if (jState && state && jState !== state) return "OUT_OF_JURISDICTION";
    if (nj && nc && nj !== nc) return "OUT_OF_JURISDICTION";
    return "OUT_OF_JURISDICTION";
  }

  if (effective === "COUNTY" || scope === "COUNTY") {
    if (!jCounty && !jState) return "UNKNOWN_JURISDICTION";
    if (!county || !state) return "UNKNOWN_JURISDICTION";
    const nc = normalizeCity(county);
    const nj = normalizeCity(jCounty);
    if (nj && nc && nc === nj && state === jState) return "IN_JURISDICTION";
    if (jState && state && jState !== state) return "OUT_OF_JURISDICTION";
    if (nj && nc && nj !== nc) return "OUT_OF_JURISDICTION";
    return "OUT_OF_JURISDICTION";
  }

  if (effective === "STATEWIDE" || scope === "STATEWIDE" || effective === "STATE") {
    if (!jState) return "UNKNOWN_JURISDICTION";
    if (!state) return "UNKNOWN_JURISDICTION";
    return state === jState ? "IN_JURISDICTION" : "OUT_OF_JURISDICTION";
  }

  if (effective === "DISTRICT") {
    if (!district) return "UNKNOWN_JURISDICTION";
    return "NOT_CHECKED";
  }

  return "UNKNOWN_JURISDICTION";
}

/** Signer-side jurisdiction check using normalized import row (no voter file yet). */
export function evaluateSignerJurisdictionStatus(
  petition: JurisdictionPetitionContext,
  normalized: { city?: string | null; county?: string | null; state?: string | null }
): JurisdictionStatusResult {
  return evaluateJurisdictionStatus(petition, {
    city: normalized.city,
    county: normalized.county,
    state: normalized.state,
  });
}

export function zip5Equal(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeZip5(a ?? "");
  const y = normalizeZip5(b ?? "");
  if (!x || !y) return false;
  return x === y;
}
