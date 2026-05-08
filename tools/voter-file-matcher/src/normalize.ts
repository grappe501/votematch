import type { NormalizedRowJson, QaFlag, VoterHeaderMapFile } from "./types.js";

export function normalizeWhitespace(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

const EMPTY_TOKENS = new Set(
  ["n/a", "na", "none", "null", "undefined", ""].map((x) => x.toLowerCase())
);

/** True when the cell should be treated as empty (n/a, NA, blank, etc.). */
export function treatAsEmpty(s: string | null | undefined): boolean {
  const t = normalizeWhitespace(s).toLowerCase();
  if (!t) return true;
  return EMPTY_TOKENS.has(t);
}

export function normalizeName(s: string | null | undefined): string {
  return normalizeWhitespace(s).toLowerCase();
}

export function normalizeCity(s: string | null | undefined): string | null {
  const t = normalizeName(s);
  return t.length ? t : null;
}

export function normalizeCounty(s: string | null | undefined): string | null {
  const t = normalizeName(s);
  return t.length ? t : null;
}

export function normalizeState(s: string | null | undefined): string | null {
  const t = normalizeName(s);
  return t.length ? t : null;
}

/** US state for storage: uppercase 2-letter or normalized token. */
export function normalizeStateUpper(s: string | null | undefined): string | null {
  const t = normalizeWhitespace(s).toUpperCase();
  return t.length ? t : null;
}

/** US ZIP: first 5 digits (legacy helper; may return null for short/invalid input). */
export function normalizeZip5(s: string | null | undefined): string | null {
  const t = normalizeWhitespace(s);
  if (!t || treatAsEmpty(t)) return null;
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 5) return digits.slice(0, 5);
  return null;
}

/** For matching: lowercase, strip non-alphanumeric. */
export function normalizeAddressKey(s: string | null | undefined): string | null {
  const t = normalizeWhitespace(s).toLowerCase();
  if (!t || treatAsEmpty(t)) return null;
  const compact = t.replace(/[^a-z0-9]+/g, "");
  return compact.length ? compact : null;
}

export function parseBirthYear(raw: string | null | undefined): number | null {
  const t = normalizeWhitespace(raw);
  if (!t || treatAsEmpty(t)) return null;
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1800 || n > 2100) return null;
  return n;
}

const MONTH_NAMES: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** Parse birth month from numeric or month-name string. */
export function parseBirthMonth(raw: string | null | undefined): number | null {
  const t = normalizeWhitespace(raw);
  if (!t || treatAsEmpty(t)) return null;
  const n = Number.parseInt(t, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return n;
  const key = t.toLowerCase().replace(/\s+/g, " ");
  const m = MONTH_NAMES[key];
  return m ?? null;
}

export function parseBirthDay(raw: string | null | undefined): number | null {
  const t = normalizeWhitespace(raw);
  if (!t || treatAsEmpty(t)) return null;
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1 || n > 31) return null;
  return n;
}

/**
 * Strict birth year for petition sheets: reject two-digit years and years before 1900.
 * Returns null and sets invalidYear when the cell is non-empty but unusable.
 */
export function parseBirthYearStrict(
  raw: string | null | undefined
): { year: number | null; invalidYear: boolean } {
  const t = normalizeWhitespace(raw);
  if (!t || treatAsEmpty(t)) return { year: null, invalidYear: false };
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n)) return { year: null, invalidYear: true };
  if (n >= 0 && n <= 99) return { year: null, invalidYear: true };
  if (n < 1900 || n > 2100) return { year: null, invalidYear: true };
  return { year: n, invalidYear: false };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Build ISO yyyy-mm-dd when parts are valid in the Gregorian sense (light checks). */
export function isoDateFromParts(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Excel 1900 date system serial to ISO date (UTC calendar date).
 * Suitable for modern petition dates; known leap-year quirk near 1900 is irrelevant here.
 */
export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (whole < 1 || whole > 2958465) return null;
  const epochMs = Date.UTC(1899, 11, 30);
  const ms = epochMs + whole * 86400000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (y < 1900 || y > 2100) return null;
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

/**
 * Parse flexible date strings to ISO yyyy-mm-dd (UTC date only).
 * Returns null if unparseable.
 */
export function parseIsoDateOnly(raw: string | null | undefined): string | null {
  const t = normalizeWhitespace(raw);
  if (!t || treatAsEmpty(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const mdY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (mdY) {
    const m = Number.parseInt(mdY[1]!, 10);
    const d = Number.parseInt(mdY[2]!, 10);
    const y = Number.parseInt(mdY[3]!, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1800 && y <= 2100) {
      const mm = String(m).padStart(2, "0");
      const dd = String(d).padStart(2, "0");
      return `${y}-${mm}-${dd}`;
    }
  }
  const isoT = Date.parse(t);
  if (!Number.isNaN(isoT)) {
    const dt = new Date(isoT);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

/**
 * Parse signed-at cell: numeric Excel serial, or string date, or empty.
 * Sets signed_at_raw to original string when non-numeric; numeric serial stored as string too.
 */
export function parseSignedAtCell(
  raw: string | null | undefined,
  allowExcelSerial: boolean
): { signed_at: string | null; signed_at_raw: string | null; usedExcelSerial: boolean } {
  const t = normalizeWhitespace(raw ?? "");
  if (!t || treatAsEmpty(t)) {
    return { signed_at: null, signed_at_raw: null, usedExcelSerial: false };
  }
  if (allowExcelSerial) {
    const n = Number.parseFloat(t.replace(/,/g, ""));
    if (Number.isFinite(n) && n > 200 && n < 6000000) {
      const iso = excelSerialToIsoDate(n);
      return {
        signed_at: iso,
        signed_at_raw: String(n),
        usedExcelSerial: true,
      };
    }
  }
  const iso = parseIsoDateOnly(t);
  return { signed_at: iso, signed_at_raw: t, usedExcelSerial: false };
}

export function normalizeExternalId(s: string | null | undefined): string | null {
  const t = normalizeWhitespace(s);
  return t.length && !treatAsEmpty(t) ? t : null;
}

/** Light title-case for display fields (input is usually lowercase-normalized). */
export function toTitleCaseFromLower(s: string | null | undefined): string | null {
  const t = normalizeWhitespace(s);
  if (!t.length) return null;
  return t
    .split(/\s+/)
    .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function todayUtcDateOnly(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function compareIsoDates(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Apply petition/source profile normalization and QA rules to a row already mapped via aliases + positions.
 * Mutates `normalized` in place (including `_qa_flags`).
 */
export function applySourceProfileNormalization(map: VoterHeaderMapFile, normalized: NormalizedRowJson): void {
  const norm = map.normalization;
  const qaCfg = map.qa;
  if (!norm && !qaCfg) return;
  const flags: QaFlag[] = [];

  const applyEmpty = (s: string | null | undefined): string | null => {
    if (s == null) return null;
    if (norm?.treatNAAsEmpty && treatAsEmpty(s)) return null;
    const t = normalizeWhitespace(s);
    if (norm?.treatNAAsEmpty && treatAsEmpty(t)) return null;
    return t.length ? t : null;
  };

  const emptyFirst = applyEmpty(normalized.first_name ?? null);
  const emptyLast = applyEmpty(normalized.last_name ?? null);
  normalized.first_name = emptyFirst ? normalizeName(emptyFirst) || null : null;
  normalized.last_name = emptyLast ? normalizeName(emptyLast) || null : null;

  let addrRaw = normalized.address_line_display;
  if (norm?.treatNAAsEmpty && treatAsEmpty(addrRaw ?? "")) {
    addrRaw = null;
    normalized.address_line_display = null;
    normalized.address = null;
  } else if (addrRaw) {
    const trimmed = normalizeWhitespace(addrRaw);
    const disp = normalizeName(trimmed) || null;
    normalized.address_line_display = disp;
    const key = normalizeAddressKey(trimmed);
    normalized.address = key;
    if (trimmed && disp && trimmed.toLowerCase() !== disp) {
      normalized.address_raw = trimmed;
    }
  }

  const cityRaw = applyEmpty(normalized.city ?? null);
  normalized.city = cityRaw ? normalizeCity(cityRaw) : null;

  let stateVal = applyEmpty(normalized.state ?? null);
  if (!stateVal && norm?.defaultState) {
    stateVal = norm.defaultState;
  }
  if (norm?.uppercaseState) {
    normalized.state = stateVal ? normalizeStateUpper(stateVal) : null;
  } else {
    normalized.state = stateVal ? normalizeState(stateVal) : null;
  }

  const zipRaw = applyEmpty(normalized.zip ?? null);
  const zipClean = normalizeZip5(zipRaw);
  if (zipRaw && !treatAsEmpty(zipRaw)) {
    const digits = normalizeWhitespace(zipRaw).replace(/\D/g, "");
    if (!zipClean || digits.length < 5) {
      flags.push("INVALID_ZIP");
      normalized.zip = null;
    } else {
      normalized.zip = zipClean;
    }
  } else {
    normalized.zip = zipClean;
  }

  let notesVal = normalized.notes ?? null;
  if (norm?.treatNAAsEmpty && treatAsEmpty(notesVal ?? "")) {
    notesVal = null;
  } else if (notesVal) {
    notesVal = normalizeWhitespace(notesVal);
  }
  normalized.notes = notesVal && notesVal.length ? notesVal : null;

  if (norm?.combineBirthDateParts) {
    const bmField = norm.birthMonthField ?? "birth_month";
    const bdField = norm.birthDayField ?? "birth_day";
    const byField = norm.birthYearField ?? "birth_year";
    const rowAny = normalized as Record<string, unknown>;
    const bmRaw =
      typeof rowAny[bmField] === "string"
        ? (rowAny[bmField] as string)
        : typeof rowAny[bmField] === "number"
          ? String(rowAny[bmField])
          : null;
    const bdRaw =
      typeof rowAny[bdField] === "string"
        ? (rowAny[bdField] as string)
        : typeof rowAny[bdField] === "number"
          ? String(rowAny[bdField])
          : null;
    const byRaw =
      typeof rowAny[byField] === "string"
        ? (rowAny[byField] as string)
        : typeof rowAny[byField] === "number"
          ? String(rowAny[byField])
          : null;

    const bm = parseBirthMonth(bmRaw);
    const bd = parseBirthDay(bdRaw);
    const { year: byStrict, invalidYear } = parseBirthYearStrict(byRaw);

    if (bmRaw && !treatAsEmpty(bmRaw) && bm == null) flags.push("INVALID_BIRTH_MONTH");
    if (bdRaw && !treatAsEmpty(bdRaw) && bd == null) flags.push("INVALID_BIRTH_DAY");
    if (byRaw && !treatAsEmpty(byRaw) && invalidYear) flags.push("INVALID_BIRTH_YEAR");

    normalized.birth_month = bm;
    normalized.birth_day = bd;
    normalized.birth_year = byStrict;

    delete rowAny[bmField];
    delete rowAny[bdField];
    delete rowAny[byField];

    if (bm != null && bd != null && byStrict != null) {
      const iso = isoDateFromParts(byStrict, bm, bd);
      if (iso) {
        normalized.birth_date = iso;
      } else {
        normalized.birth_date = null;
        if (qaCfg?.flagInvalidBirthDate !== false) flags.push("INVALID_BIRTH_DATE");
      }
    } else {
      normalized.birth_date = null;
      const anyPart =
        (bmRaw && !treatAsEmpty(bmRaw)) || (bdRaw && !treatAsEmpty(bdRaw)) || (byRaw && !treatAsEmpty(byRaw));
      if (anyPart && qaCfg?.flagInvalidBirthDate !== false) {
        if (!(bm != null && bd != null && byStrict != null)) {
          flags.push("INVALID_BIRTH_DATE");
        }
      }
    }
  } else {
    if (normalized.birth_year != null && normalized.birth_year < 1900) {
      normalized.birth_year = null;
      flags.push("INVALID_BIRTH_YEAR");
    }
  }

  const signedRawCell = normalized.signed_at_raw ?? null;
  const allowSerial = norm?.signedAtMayBeExcelSerial === true;
  const parsed = parseSignedAtCell(signedRawCell, allowSerial);
  normalized.signed_at_raw = parsed.signed_at_raw;
  normalized.signed_at = parsed.signed_at;

  if (signedRawCell && !treatAsEmpty(signedRawCell) && parsed.signed_at == null) {
    flags.push("INVALID_SIGNED_AT");
  }
  if (parsed.signed_at) {
    const today = todayUtcDateOnly();
    if (compareIsoDates(parsed.signed_at, today) > 0) {
      flags.push("FUTURE_SIGNED_AT");
    }
  }

  if (qaCfg?.flagMissingName !== false) {
    if (!normalized.first_name) flags.push("MISSING_FIRST_NAME");
    if (!normalized.last_name) flags.push("MISSING_LAST_NAME");
  }
  if (qaCfg?.flagMissingAddress !== false && !normalized.address_line_display && !normalized.address) {
    flags.push("MISSING_ADDRESS");
  }
  if (qaCfg?.flagMissingCity !== false && !normalized.city) flags.push("MISSING_CITY");
  if (qaCfg?.flagMissingState !== false && !normalized.state) flags.push("MISSING_STATE");
  if (qaCfg?.flagMissingZip !== false && !normalized.zip) flags.push("MISSING_ZIP");

  const expectedCity = norm?.expectedPrimaryCity?.toLowerCase().trim();
  if (qaCfg?.flagNonJacksonvilleCity !== false && expectedCity && normalized.city && normalized.city !== expectedCity) {
    flags.push("NON_JACKSONVILLE_CITY");
  }

  if (qaCfg?.flagNotesPresent !== false && normalized.notes) {
    flags.push("HAS_NOTES");
  }

  const uniq = new Set(flags);
  normalized._qa_flags = uniq.size ? Array.from(uniq).sort() : [];
}

/** When no profile normalization block exists, still attach empty QA flags for stable JSON shape. */
export function ensureQaFlagsArray(normalized: NormalizedRowJson): void {
  if (!Array.isArray(normalized._qa_flags)) {
    normalized._qa_flags = [];
  }
}
