import { readFile } from "node:fs/promises";
import type { HeaderAliasMap, NormalizedRowJson, RawRowJson, VoterHeaderMapFile } from "./types.js";
import {
  normalizeExternalId,
  normalizeName,
  normalizeCity,
  normalizeCounty,
  normalizeState,
  normalizeZip5,
  normalizeAddressKey,
  normalizeWhitespace,
  parseBirthYear,
  parseIsoDateOnly,
  treatAsEmpty,
} from "./normalize.js";

function headerKey(h: string): string {
  return h.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Map each file header label -> column index (first occurrence wins). */
export function buildHeaderIndex(headers: readonly string[]): Map<string, number> {
  const idx = new Map<string, number>();
  for (let i = 0; i < headers.length; i++) {
    const k = headerKey(headers[i] ?? "");
    if (k.length === 0) continue;
    if (!idx.has(k)) idx.set(k, i);
  }
  return idx;
}

/**
 * Convert Excel column letter ("A", "F", "AA") or 1-based numeric string ("1" = column A) to 0-based index.
 */
export function columnSpecToIndex(spec: string): number | null {
  const k = spec.trim();
  if (!k) return null;
  if (/^\d+$/.test(k)) {
    const n = Number.parseInt(k, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n - 1;
  }
  if (/^[A-Za-z]+$/.test(k)) {
    let result = 0;
    const upper = k.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const code = upper.charCodeAt(i) - 64;
      if (code < 1 || code > 26) return null;
      result = result * 26 + code;
    }
    return result - 1;
  }
  return null;
}

/** Positional picks: first matching column spec wins. */
export function pickFromColumnPositions(
  columnPositions: Record<string, string> | undefined,
  logicalField: string,
  cells: readonly string[]
): string | null {
  if (!columnPositions) return null;
  for (const [colSpec, logical] of Object.entries(columnPositions)) {
    if (logical !== logicalField) continue;
    const idx = columnSpecToIndex(colSpec);
    if (idx == null || idx < 0 || idx >= cells.length) continue;
    const v = cells[idx];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

export function listPositionalMappingsApplied(columnPositions: Record<string, string> | undefined): string[] {
  if (!columnPositions) return [];
  return Object.entries(columnPositions).map(([col, field]) => `column ${col.toUpperCase()} -> ${field}`);
}

function pickField(
  headerIndex: Map<string, number>,
  aliases: readonly string[] | undefined,
  cells: readonly string[]
): string | null {
  if (!aliases?.length) return null;
  for (const al of aliases) {
    const j = headerIndex.get(headerKey(al));
    if (j == null) continue;
    const v = cells[j];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

function splitFullName(full: string): { first: string; last: string } {
  const t = full.replace(/\s+/g, " ").trim();
  if (!t) return { first: "", last: "" };
  const parts = t.split(" ");
  if (parts.length === 1) return { first: parts[0]!, last: parts[0]! };
  return { first: parts[0]!, last: parts.slice(1).join(" ") };
}

/**
 * Build raw_json (original header -> cell) and normalized_json using alias map + optional columnPositions.
 * Positional mappings override alias-derived values for the same logical field.
 */
export function mapRowWithAliases(
  headers: readonly string[],
  cells: readonly string[],
  map: VoterHeaderMapFile
): { raw: RawRowJson; normalized: NormalizedRowJson } {
  const headerIndex = buildHeaderIndex(headers);
  const aliases = map.headerAliases as HeaderAliasMap;
  const pos = map.columnPositions;

  const raw: RawRowJson = {};
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h == null) continue;
    raw[h] = cells[i] ?? "";
  }

  let first = pickField(headerIndex, aliases.first_name, cells);
  let last = pickField(headerIndex, aliases.last_name, cells);
  const fullRaw = pickField(headerIndex, aliases.full_name, cells);
  if ((!first || !first.trim()) && (!last || !last.trim()) && fullRaw) {
    const sp = splitFullName(fullRaw);
    first = sp.first;
    last = sp.last;
  }

  const birthDateRaw = pickField(headerIndex, aliases.birth_date, cells);
  const birthYearRaw = pickField(headerIndex, aliases.birth_year, cells);
  const signedRaw = pickField(headerIndex, aliases.signed_at, cells);
  const addrFromPos = pickFromColumnPositions(pos, "address", cells);
  const addrFromAlias = pickField(headerIndex, aliases.address, cells);
  /** Prefer alias when present; positional fills missing/bad header columns (petition column F). */
  const addrRaw = addrFromAlias?.trim() ? addrFromAlias : (addrFromPos ?? addrFromAlias);

  const birthMonthRaw = pickField(headerIndex, aliases.birth_month, cells);
  const birthDayRaw = pickField(headerIndex, aliases.birth_day, cells);
  const notesRaw = pickField(headerIndex, aliases.notes, cells);

  const combineBirth = map.normalization?.combineBirthDateParts === true;

  const addrTrimmed = addrRaw ? normalizeWhitespace(addrRaw) : "";
  const addrDisplay = addrTrimmed ? normalizeName(addrTrimmed) || null : null;
  const normalized: NormalizedRowJson = {
    voter_id: normalizeExternalId(pickField(headerIndex, aliases.voter_id, cells)),
    external_voter_id: normalizeExternalId(pickField(headerIndex, aliases.external_voter_id, cells)),
    state_voter_id: normalizeExternalId(pickField(headerIndex, aliases.state_voter_id, cells)),
    first_name: normalizeName(first) || null,
    last_name: normalizeName(last) || null,
    full_name: normalizeName(fullRaw) || null,
    birth_date: combineBirth ? null : parseIsoDateOnly(birthDateRaw),
    birth_year: combineBirth ? null : parseBirthYear(birthYearRaw),
    address_line_display: addrDisplay,
    address: normalizeAddressKey(addrTrimmed),
    ...(addrTrimmed && addrDisplay && addrTrimmed.toLowerCase() !== addrDisplay
      ? { address_raw: addrTrimmed }
      : {}),
    city: normalizeCity(pickField(headerIndex, aliases.city, cells)),
    county: normalizeCounty(pickField(headerIndex, aliases.county, cells)),
    state: normalizeState(pickField(headerIndex, aliases.state, cells)),
    zip: normalizeZip5(pickField(headerIndex, aliases.zip, cells)),
    signed_at_raw: signedRaw && !treatAsEmpty(signedRaw) ? signedRaw : null,
    signed_at: parseIsoDateOnly(signedRaw),
    notes: notesRaw && !treatAsEmpty(notesRaw) ? notesRaw.replace(/\s+/g, " ").trim() : null,
  };

  if (combineBirth) {
    const rowRec = normalized as Record<string, unknown>;
    const bmField = map.normalization?.birthMonthField ?? "birth_month";
    const bdField = map.normalization?.birthDayField ?? "birth_day";
    const byField = map.normalization?.birthYearField ?? "birth_year";
    rowRec[bmField] = birthMonthRaw;
    rowRec[bdField] = birthDayRaw;
    rowRec[byField] = birthYearRaw;
  }

  return { raw, normalized };
}

/** Serialize map for import_header_maps.header_map (stable JSON). */
export function serializeHeaderMapForDb(map: VoterHeaderMapFile): Record<string, unknown> {
  const out: Record<string, unknown> = {
    canonicalDatabase: map.canonicalDatabase,
    headerAliases: map.headerAliases,
  };
  if (map.profileName) out.profileName = map.profileName;
  if (map.description) out.description = map.description;
  if (map.sheetName) out.sheetName = map.sheetName;
  if (map.headerRow != null) out.headerRow = map.headerRow;
  if (map.dataStartRow != null) out.dataStartRow = map.dataStartRow;
  if (map.columnPositions) out.columnPositions = map.columnPositions;
  if (map.normalization) out.normalization = map.normalization;
  if (map.qa) out.qa = map.qa;
  if (map.matching) out.matching = map.matching;
  if (map.validation) out.validation = map.validation;
  return out;
}

export async function loadHeaderMapFile(mapPath: string): Promise<VoterHeaderMapFile> {
  const raw = await readFile(mapPath, "utf8");
  const j = JSON.parse(raw) as VoterHeaderMapFile;
  if (!j.headerAliases || typeof j.headerAliases !== "object") {
    throw new Error("Map file must include headerAliases object");
  }
  if (!j.canonicalDatabase?.columns || typeof j.canonicalDatabase.columns !== "object") {
    throw new Error("Map file must include canonicalDatabase.columns");
  }
  if (!Array.isArray(j.headerAliases.first_name) || !Array.isArray(j.headerAliases.last_name)) {
    throw new Error("headerAliases.first_name and headerAliases.last_name (arrays) are required");
  }
  if (j.columnPositions && typeof j.columnPositions !== "object") {
    for (const [spec, logical] of Object.entries(j.columnPositions)) {
      if (columnSpecToIndex(spec) == null) {
        throw new Error(`columnPositions key "${spec}" is not a valid Excel column or 1-based index`);
      }
      if (!logical || typeof logical !== "string") {
        throw new Error(`columnPositions["${spec}"] must be a non-empty logical field name`);
      }
    }
  }
  return j;
}
