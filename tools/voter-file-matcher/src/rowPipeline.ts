import type { MatchOutcome, NormalizedRowJson, QaFlag, QaFlagsCsvRow, RawRowJson, VoterHeaderMapFile } from "./types.js";
import { mapRowWithAliases } from "./headerMap.js";
import { applySourceProfileNormalization, ensureQaFlagsArray } from "./normalize.js";

export type PreparedImportRow = {
  row_number: number;
  chunk_number: number;
  raw: RawRowJson;
  normalized: NormalizedRowJson;
};

/** Stable key for within-file duplicate detection (normalized fields only). */
export function stableDuplicateKey(n: NormalizedRowJson): string {
  const fn = n.first_name ?? "";
  const ln = n.last_name ?? "";
  const bd = n.birth_date ?? "";
  const by = n.birth_year != null ? String(n.birth_year) : "";
  const addr = n.address ?? "";
  const zip = n.zip ?? "";
  return [fn, ln, bd || by, addr, zip].join("\u001f");
}

/**
 * Mark POSSIBLE_DUPLICATE_WITHIN_FILE on rows sharing stableDuplicateKey when enabled in map.
 * Returns count of rows that received the duplicate flag.
 */
export function applyWithinFileDuplicateFlags(
  map: VoterHeaderMapFile,
  rows: { normalized: NormalizedRowJson }[]
): number {
  if (map.qa?.flagDuplicateRowsWithinFile === false) return 0;
  const counts = new Map<string, number>();
  for (const { normalized } of rows) {
    const k = stableDuplicateKey(normalized);
    if (!k.replace(/\u001f/g, "").length) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let flagged = 0;
  for (const { normalized } of rows) {
    const k = stableDuplicateKey(normalized);
    const c = counts.get(k) ?? 0;
    if (c > 1) {
      const flags = new Set(normalized._qa_flags ?? []);
      flags.add("POSSIBLE_DUPLICATE_WITHIN_FILE");
      normalized._qa_flags = Array.from(flags).sort();
      flagged += 1;
    }
  }
  return flagged;
}

export function processMappedRow(
  map: VoterHeaderMapFile,
  headers: readonly string[],
  cells: readonly string[]
): { raw: RawRowJson; normalized: NormalizedRowJson } {
  const { raw, normalized } = mapRowWithAliases(headers, cells, map);
  applySourceProfileNormalization(map, normalized);
  ensureQaFlagsArray(normalized);
  return { raw, normalized };
}

export function qaFlagsToString(flags: QaFlag[] | undefined): string {
  if (!flags?.length) return "";
  return flags.join("|");
}

export function buildQaFlagsCsvRow(
  rowNumber: number,
  normalized: NormalizedRowJson,
  outcome?: MatchOutcome | null,
  reviewStatus?: string | null
): QaFlagsCsvRow {
  const flags = normalized._qa_flags ?? [];
  return {
    row_number: rowNumber,
    qa_flags: qaFlagsToString(flags),
    first_name_present: Boolean(normalized.first_name),
    last_name_present: Boolean(normalized.last_name),
    address_present: Boolean(normalized.address || normalized.address_line_display),
    city: normalized.city ?? "",
    state: normalized.state ?? "",
    zip: normalized.zip ?? "",
    signed_at: normalized.signed_at ?? "",
    notes_present: Boolean(normalized.notes),
    match_status: outcome?.status ?? "",
    review_status: reviewStatus?.trim() ? reviewStatus.trim() : "UNREVIEWED",
    voter_id: outcome?.voterId ?? "",
  };
}
