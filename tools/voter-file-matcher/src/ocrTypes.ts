/** One extracted signer row from vision OCR (draft; human review required). */
export type OcrExtractedRowJson = {
  row_number: number;
  extraction_confidence_pct: number | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  birth_month: string | null;
  birth_day: string | null;
  birth_year: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  signed_at: string | null;
  notes: string | null;
  uncertain_fields: string[];
  raw_line_text: string | null;
};

/** Full structured response from the vision model. */
export type OcrPetitionExtractionResult = {
  document_type: "petition_signature_page";
  overall_confidence_pct: number;
  warnings: string[];
  rows: OcrExtractedRowJson[];
};

export type PetitionOcrContext = {
  petition_code: string;
  petition_name?: string | null;
  project_key?: string | null;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function clampInt(n: unknown, min: number, max: number): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeRow(raw: unknown, idx: number): OcrExtractedRowJson | null {
  if (!isRecord(raw)) return null;
  const row_number = typeof raw.row_number === "number" && raw.row_number > 0 ? Math.floor(raw.row_number) : idx + 1;
  const uncertain = isStringArray(raw.uncertain_fields) ? raw.uncertain_fields : [];
  const str = (k: string): string | null => {
    const v = raw[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  };
  return {
    row_number,
    extraction_confidence_pct: clampInt(raw.extraction_confidence_pct, 0, 100),
    first_name: str("first_name"),
    last_name: str("last_name"),
    full_name: str("full_name"),
    birth_month: str("birth_month"),
    birth_day: str("birth_day"),
    birth_year: str("birth_year"),
    address: str("address"),
    city: str("city"),
    state: str("state"),
    zip: str("zip"),
    signed_at: str("signed_at"),
    notes: str("notes"),
    uncertain_fields: uncertain,
    raw_line_text: str("raw_line_text"),
  };
}

/**
 * Validates parsed JSON from the model. Returns null if invalid.
 * Does not guess missing fields; drops malformed rows.
 */
export function parseOcrExtractionJson(parsed: unknown): OcrPetitionExtractionResult | null {
  if (!isRecord(parsed)) return null;
  if (parsed.document_type !== "petition_signature_page") return null;
  const overall_confidence_pct = clampInt(parsed.overall_confidence_pct, 0, 100) ?? 0;
  const warnings = isStringArray(parsed.warnings) ? parsed.warnings : [];
  const rowsIn = Array.isArray(parsed.rows) ? parsed.rows : [];
  const rows: OcrExtractedRowJson[] = [];
  for (let i = 0; i < rowsIn.length; i++) {
    const r = normalizeRow(rowsIn[i], i);
    if (r) rows.push(r);
  }
  return {
    document_type: "petition_signature_page",
    overall_confidence_pct,
    warnings,
    rows,
  };
}
