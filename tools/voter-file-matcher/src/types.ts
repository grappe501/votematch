/** QA flags stored on normalized rows (import_rows.normalized_json._qa_flags). */
export type QaFlag =
  | "MISSING_FIRST_NAME"
  | "MISSING_LAST_NAME"
  | "MISSING_ADDRESS"
  | "MISSING_CITY"
  | "MISSING_STATE"
  | "MISSING_ZIP"
  | "INVALID_ZIP"
  | "INVALID_BIRTH_MONTH"
  | "INVALID_BIRTH_DAY"
  | "INVALID_BIRTH_YEAR"
  | "INVALID_BIRTH_DATE"
  | "INVALID_SIGNED_AT"
  | "FUTURE_SIGNED_AT"
  | "NON_JACKSONVILLE_CITY"
  | "HAS_NOTES"
  | "POSSIBLE_DUPLICATE_WITHIN_FILE";

/** Logical fields produced from a header map + row cells (stored in import_rows.normalized_json). */
export type NormalizedRowJson = {
  voter_id?: string | null;
  external_voter_id?: string | null;
  state_voter_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  /** Numeric month 1–12 when parsed from source. */
  birth_month?: number | null;
  /** Numeric day 1–31 when parsed from source. */
  birth_day?: number | null;
  birth_date?: string | null;
  birth_year?: number | null;
  /** Lowercased trimmed address for display on signature rows. */
  address_line_display?: string | null;
  /** Alphanumeric compact key used for tiered matching. */
  address?: string | null;
  /** Original address text when it differs from normalized display form. */
  address_raw?: string | null;
  city?: string | null;
  county?: string | null;
  state?: string | null;
  zip?: string | null;
  signed_at?: string | null;
  /** Original signed-at cell text or serial string before normalization. */
  signed_at_raw?: string | null;
  notes?: string | null;
  _qa_flags?: QaFlag[];
};

export type RawRowJson = Record<string, string>;

export type MatchStatus = "MATCHED" | "NOT_FOUND" | "MULTIPLE_MATCHES" | "WEAK_MATCH" | "ERROR";

/** import_voter_matches.review_status (migration 002); enforced in application, not DB CHECK */
export type ImportReviewStatus =
  | "UNREVIEWED"
  | "APPROVED"
  | "REJECTED"
  | "NEEDS_MORE_INFO"
  | "SUPERSEDED";

export type HeaderAliasMap = Record<string, readonly string[]>;

export type SourceProfileNormalization = {
  combineBirthDateParts?: boolean;
  birthMonthField?: string;
  birthDayField?: string;
  birthYearField?: string;
  signedAtMayBeExcelSerial?: boolean;
  treatNAAsEmpty?: boolean;
  defaultState?: string;
  expectedPrimaryCity?: string;
  uppercaseState?: boolean;
};

export type SourceProfileQa = {
  flagMissingName?: boolean;
  flagMissingAddress?: boolean;
  flagMissingCity?: boolean;
  flagMissingState?: boolean;
  flagMissingZip?: boolean;
  flagInvalidBirthDate?: boolean;
  flagFutureSignedAt?: boolean;
  flagNonJacksonvilleCity?: boolean;
  flagNotesPresent?: boolean;
  flagDuplicateRowsWithinFile?: boolean;
};

export type MatchingTierSet = "default" | "petition_mail";

export type SourceProfileMatching = {
  tierSet?: MatchingTierSet;
  strongFields?: readonly string[];
  fallbackFields?: readonly string[];
};

export type SourceProfileValidation = {
  /** Logical header alias keys required for this profile (overrides built-in defaults). */
  requiredHeaderFields?: readonly string[];
};

/**
 * Map file: optional source profile metadata + header aliases + canonical physical column names for the voter table.
 * `sos-voter-map.json` uses only canonicalDatabase + headerAliases; petition profiles add sheet/position/QA/matching.
 */
export type VoterHeaderMapFile = {
  profileName?: string;
  description?: string;
  sheetName?: string;
  /** 1-based row index of header labels. */
  headerRow?: number;
  /** 1-based first data row. */
  dataStartRow?: number;
  /** Excel column letters ("F"), or 1-based column numbers as string keys ("6"), mapped to logical import fields. */
  columnPositions?: Record<string, string>;
  normalization?: SourceProfileNormalization;
  qa?: SourceProfileQa;
  matching?: SourceProfileMatching;
  validation?: SourceProfileValidation;
  canonicalDatabase: {
    table?: string;
    columns: Record<string, string>;
  };
  headerAliases: HeaderAliasMap;
};

/**
 * Validated physical column names on the canonical voter table (SQL identifiers).
 * Optional keys enable higher match tiers when mapped.
 */
export type CanonicalColumnMap = {
  id: string;
  voter_id?: string;
  external_voter_id?: string;
  state_voter_id?: string;
  first_name: string;
  last_name: string;
  birth_date?: string;
  birth_year?: string;
  county: string;
  address?: string;
  zip?: string;
  city?: string;
};

export type MatchOutcome = {
  status: MatchStatus;
  matchMethod: string | null;
  matchConfidence: number | null;
  voterId: string | null;
  candidateIds: string[];
  notes: string | null;
};

export type ParsedSheet = {
  headers: string[];
  rows: string[][];
};

export type SummaryReportJson = {
  batch_id: string;
  petition_id: string | null;
  petition_code: string | null;
  file_name: string;
  project_key: string;
  total_rows: number;
  matched: number;
  not_found: number;
  multiple_matches: number;
  weak_matches: number;
  errors: number;
  match_rate: number;
  permanent_signatures_created_or_updated: number;
  by_city: Record<string, number>;
  by_county: Record<string, number>;
  /** chunk index (string) -> match_status -> count */
  by_chunk: Record<string, Record<string, number>>;
  created_at: string;
  completed_at: string;
  /** Present when a source profile JSON was used for the import. */
  source_profile?: string | null;
  qa_counts?: Record<string, number>;
  date_signed_min?: string | null;
  date_signed_max?: string | null;
  city_counts?: Record<string, number>;
  state_counts?: Record<string, number>;
  zip_counts?: Record<string, number>;
  duplicate_within_file_count?: number;
  rows_with_notes_count?: number;
  non_jacksonville_city_count?: number;
  future_signed_at_count?: number;
  /** Present after migration 002 + import_voter_matches.review columns */
  review_queue_count?: number;
  approved_count?: number;
  rejected_count?: number;
  needs_more_info_count?: number;
  manually_attached_count?: number;
  /** Initiative / reporting metadata from `petitions` when present (migration 006). */
  initiative_scope?: string | null;
  reporting_geo?: string | null;
  /** Average import_voter_matches.match_confidence_pct for this batch. */
  avg_match_confidence_pct?: number | null;
  slam_dunk_100_count?: number;
  confidence_90_99_count?: number;
  confidence_75_89_count?: number;
  confidence_50_74_count?: number;
  confidence_1_49_count?: number;
  confidence_0_count?: number;
  /** Batch-level bucket counts (import_voter_matches). */
  confidence_distribution?: Record<string, number>;
};

export type CsvReportRow = {
  row_number: number;
  match_status: string;
  voter_id: string;
  candidate_count: number;
  /** Integer 0–100 identity-match confidence (migration 006). */
  match_confidence_pct: number | null;
  signer_first_name: string;
  signer_last_name: string;
  signer_city: string;
  signer_county: string;
  signer_address: string;
  signer_zip: string;
  notes: string;
};

/** Privacy-minimized QA export (no raw street address). */
export type QaFlagsCsvRow = {
  row_number: number;
  qa_flags: string;
  first_name_present: boolean;
  last_name_present: boolean;
  address_present: boolean;
  city: string;
  state: string;
  zip: string;
  signed_at: string;
  notes_present: boolean;
  match_status: string;
  review_status: string;
  voter_id: string;
};

export type PreflightSummaryJson = {
  file_name: string;
  sheet_name: string;
  row_count: number;
  column_count: number;
  detected_headers: string[];
  mapped_fields: string[];
  unmapped_headers: string[];
  positional_mappings_applied: string[];
  first_data_row_number: number;
  non_empty_counts_by_field: Record<string, number>;
  qa_counts: Record<string, number>;
  date_signed_min: string | null;
  date_signed_max: string | null;
  city_counts: Record<string, number>;
  state_counts: Record<string, number>;
  zip_counts: Record<string, number>;
  duplicate_within_file_count: number;
  notes_present_count: number;
  ready_for_import: boolean;
  warnings: string[];
};

/** Logical guess from physical column name only (schema discovery). */
export type ColumnLogicalKind =
  | "voter_id_candidate"
  | "first_name_candidate"
  | "last_name_candidate"
  | "full_name_candidate"
  | "birth_date_candidate"
  | "birth_year_candidate"
  | "birth_month_candidate"
  | "birth_day_candidate"
  | "address_candidate"
  | "city_candidate"
  | "county_candidate"
  | "state_candidate"
  | "zip_candidate"
  | "ward_candidate"
  | "precinct_candidate"
  | "district_candidate"
  | "updated_at_candidate"
  | "unknown";

export type SchemaColumnMeta = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  logical_classification: ColumnLogicalKind;
};

export type RelatedTableDiscovery = {
  qualified_table: string;
  table_type: string;
  match_reason: string;
  columns: SchemaColumnMeta[];
  possible_join_keys_with_canonical: {
    canonical_column: string;
    related_column: string;
    hint: string;
  }[];
};

export type DiscoverVoterSchemaResult = {
  resolved_table: string;
  columns: SchemaColumnMeta[];
  related_tables?: RelatedTableDiscovery[];
};

export type MatchSourcePlanConfidence = "high" | "medium" | "low" | "missing";

export type MatchSourcePlanColumnEntry = {
  source_expression: string | null;
  confidence: MatchSourcePlanConfidence;
  notes: string[];
};

export type MatchSourcePlanJson = {
  created_at: string;
  canonical_table: string;
  target_match_source: string;
  standard_columns: Record<string, MatchSourcePlanColumnEntry>;
  missing_or_low_confidence: { standard_column: string; confidence: MatchSourcePlanConfidence; notes: string[] }[];
  warnings: string[];
  operator_notes: string[];
};

export type CandidateProbeSummary = {
  sampled_rows: number;
  matched: number;
  not_found: number;
  multiple_matches: number;
  weak_matches: number;
  errors: number;
  match_methods: Record<string, number>;
};

export type ImportPlanOperatorReviewStatus = "DRAFT" | "REVIEWED" | "EXECUTED" | "SUPERSEDED" | "CANCELLED";

export type ImportPlanJson = {
  plan_version: 1;
  plan_key: string;
  created_at: string;
  project_key: string;
  petition_code: string;
  petition_name: string;
  source_label: string | null;
  source_file: {
    path: string;
    name: string;
    sha256: string;
    size_bytes: number | null;
  };
  source_profile: {
    path: string;
    profile_name: string | null;
  };
  map: {
    path: string | null;
  };
  canonical_table: string | null;
  match_source: {
    mode: "match_source" | "canonical_table";
    table: string | null;
  };
  preflight: PreflightSummaryJson;
  /** Snapshot from evaluateMatchReadiness (JSON-serializable). */
  readiness: Record<string, unknown>;
  candidate_probe: CandidateProbeSummary;
  decision: {
    ready_for_import: boolean;
    projected_matching_quality: "strong" | "partial" | "weak" | "not_ready";
    blocking_reasons: string[];
    warnings: string[];
  };
  operator_review: {
    status: ImportPlanOperatorReviewStatus;
    reviewed_by: string | null;
    reviewed_at: string | null;
    note: string | null;
  };
  execution: {
    executed: boolean;
    import_batch_id: string | null;
    executed_at: string | null;
  };
  /** When true, execution may create/update the initiative row from plan fields + CLI. */
  auto_create_initiative?: boolean;
  /** Snapshot from `petitions` when preparing the plan (initiative = petition). */
  initiative_snapshot?: {
    initiative_scope: string | null;
    reporting_geo: string | null;
    target_signature_count: number | null;
    existed_in_database: boolean;
  };
};

/** OCR vision extraction (draft rows; separate from voter match confidence). */
export type { OcrExtractedRowJson, OcrPetitionExtractionResult, PetitionOcrContext } from "./ocrTypes.js";
