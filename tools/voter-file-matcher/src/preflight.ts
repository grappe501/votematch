/** Sheet-level preflight: header coverage, mapped-field counts, QA tallies (no database reads). Used by `--preflight-file`, `--match-readiness`, and `--prepare-import-plan`. */
import { basename } from "node:path";
import type { NormalizedRowJson, ParsedSheet, PreflightSummaryJson, VoterHeaderMapFile } from "./types.js";
import { buildHeaderIndex, columnSpecToIndex, listPositionalMappingsApplied } from "./headerMap.js";
import { applyWithinFileDuplicateFlags, processMappedRow } from "./rowPipeline.js";

function headerKey(h: string): string {
  return h.replace(/\s+/g, " ").trim().toLowerCase();
}

function columnMatchedByAlias(j: number, headers: readonly string[], map: VoterHeaderMapFile): boolean {
  const hk = headerKey(headers[j] ?? "");
  if (!hk) return false;
  for (const [, aliases] of Object.entries(map.headerAliases)) {
    if (!Array.isArray(aliases)) continue;
    for (const al of aliases) {
      if (headerKey(al) === hk) return true;
    }
  }
  return false;
}

function columnMatchedByPosition(j: number, map: VoterHeaderMapFile): boolean {
  if (!map.columnPositions) return false;
  for (const [spec] of Object.entries(map.columnPositions)) {
    if (columnSpecToIndex(spec) === j) return true;
  }
  return false;
}

function unmappedHeaders(headers: readonly string[], map: VoterHeaderMapFile): string[] {
  const out: string[] = [];
  for (let j = 0; j < headers.length; j++) {
    const h = headers[j] ?? "";
    if (!headerKey(h)) continue;
    if (columnMatchedByAlias(j, headers, map)) continue;
    if (columnMatchedByPosition(j, map)) continue;
    out.push(h);
  }
  return out;
}

function logicalMappedFields(map: VoterHeaderMapFile): string[] {
  const s = new Set<string>();
  for (const k of Object.keys(map.headerAliases)) {
    s.add(k);
  }
  if (map.columnPositions) {
    for (const v of Object.values(map.columnPositions)) {
      s.add(v);
    }
  }
  return Array.from(s).sort();
}

function fieldColumnResolvable(field: string, headers: readonly string[], map: VoterHeaderMapFile): boolean {
  const headerIndex = buildHeaderIndex(headers);
  const aliases = map.headerAliases[field];
  if (Array.isArray(aliases)) {
    for (const al of aliases) {
      if (headerIndex.has(headerKey(al))) return true;
    }
  }
  if (map.columnPositions) {
    for (const [spec, logical] of Object.entries(map.columnPositions)) {
      if (logical === field && columnSpecToIndex(spec) != null) return true;
    }
  }
  return false;
}

const DEFAULT_REQUIRED_HEADER_FIELDS = [
  "first_name",
  "last_name",
  "city",
  "county",
  "zip",
  "address",
  "voter_id",
] as const;

export function runPreflightOnSheet(
  sheet: ParsedSheet,
  fileName: string,
  map: VoterHeaderMapFile
): PreflightSummaryJson {
  const warnings: string[] = [];
  const sheetName = map.sheetName ?? "Sheet1";
  const headerRow = map.headerRow && map.headerRow > 0 ? map.headerRow : 1;
  const dataStartRow = map.dataStartRow && map.dataStartRow > headerRow ? map.dataStartRow : headerRow + 1;

  const required =
    map.validation?.requiredHeaderFields && map.validation.requiredHeaderFields.length > 0
      ? [...map.validation.requiredHeaderFields]
      : [...DEFAULT_REQUIRED_HEADER_FIELDS];

  for (const f of required) {
    if (!fieldColumnResolvable(f, sheet.headers, map)) {
      warnings.push(`Required logical field "${f}" has no resolvable column (aliases or columnPositions).`);
    }
  }

  const normalizedRows: NormalizedRowJson[] = [];
  for (const cells of sheet.rows) {
    const { normalized } = processMappedRow(map, sheet.headers, cells);
    normalizedRows.push(normalized);
  }

  const dupCount = applyWithinFileDuplicateFlags(
    map,
    normalizedRows.map((n) => ({ normalized: n }))
  );
  if (dupCount > 0) {
    warnings.push(`${dupCount} rows appear in duplicate key groups (same name, birth, address key, zip).`);
  }

  const non_empty_counts_by_field: Record<string, number> = {};
  const fieldsToCount = [
    "first_name",
    "last_name",
    "birth_month",
    "birth_day",
    "birth_year",
    "birth_date",
    "address",
    "city",
    "state",
    "zip",
    "signed_at",
    "notes",
  ] as const;
  for (const f of fieldsToCount) {
    non_empty_counts_by_field[f] = 0;
  }
  const qa_counts: Record<string, number> = {};
  const city_counts: Record<string, number> = {};
  const state_counts: Record<string, number> = {};
  const zip_counts: Record<string, number> = {};
  const signedDates: string[] = [];
  let notes_present_count = 0;
  let future_signed_at_count = 0;
  let non_jacksonville_city_count = 0;

  for (const n of normalizedRows) {
    for (const f of fieldsToCount) {
      let nonEmpty = false;
      if (f === "address") {
        nonEmpty = Boolean(
          (n.address && String(n.address).length > 0) ||
            (n.address_line_display && String(n.address_line_display).length > 0)
        );
      } else {
        const v = (n as Record<string, unknown>)[f];
        nonEmpty = v != null && v !== "";
      }
      if (nonEmpty) {
        non_empty_counts_by_field[f] = (non_empty_counts_by_field[f] ?? 0) + 1;
      }
    }
    for (const fl of n._qa_flags ?? []) {
      qa_counts[fl] = (qa_counts[fl] ?? 0) + 1;
      if (fl === "FUTURE_SIGNED_AT") future_signed_at_count += 1;
      if (fl === "NON_JACKSONVILLE_CITY") non_jacksonville_city_count += 1;
    }
    if (n.city) {
      const k = n.city;
      city_counts[k] = (city_counts[k] ?? 0) + 1;
    }
    if (n.state) {
      const k = n.state;
      state_counts[k] = (state_counts[k] ?? 0) + 1;
    }
    if (n.zip) {
      const k = n.zip;
      zip_counts[k] = (zip_counts[k] ?? 0) + 1;
    }
    if (n.signed_at) {
      signedDates.push(n.signed_at);
    }
    if (n.notes) notes_present_count += 1;
  }

  signedDates.sort();
  const date_signed_min = signedDates.length ? signedDates[0]! : null;
  const date_signed_max = signedDates.length ? signedDates[signedDates.length - 1]! : null;

  const duplicate_within_file_count = normalizedRows.filter((n) =>
    (n._qa_flags ?? []).includes("POSSIBLE_DUPLICATE_WITHIN_FILE")
  ).length;

  const ready_for_import = required.every((f) => fieldColumnResolvable(f, sheet.headers, map));

  return {
    file_name: basename(fileName),
    sheet_name: sheetName,
    row_count: sheet.rows.length,
    column_count: sheet.headers.length,
    detected_headers: [...sheet.headers],
    mapped_fields: logicalMappedFields(map),
    unmapped_headers: unmappedHeaders(sheet.headers, map),
    positional_mappings_applied: listPositionalMappingsApplied(map.columnPositions),
    first_data_row_number: dataStartRow,
    non_empty_counts_by_field,
    qa_counts,
    date_signed_min,
    date_signed_max,
    city_counts,
    state_counts,
    zip_counts,
    duplicate_within_file_count,
    notes_present_count,
    ready_for_import,
    warnings,
  };
}
