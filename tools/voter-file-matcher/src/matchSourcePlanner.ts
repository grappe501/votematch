import type { Pool } from "pg";
import { assertSqlIdent } from "./db.js";
import { discoverVoterSchema } from "./schemaDiscovery.js";
import { getStandardMatchColumns } from "./matchSource.js";
import type {
  ColumnLogicalKind,
  DiscoverVoterSchemaResult,
  MatchSourcePlanColumnEntry,
  MatchSourcePlanConfidence,
  MatchSourcePlanJson,
  SchemaColumnMeta,
} from "./types.js";

const TABLE_ALIAS = "vr";

function normCompact(name: string): string {
  return name.toLowerCase().replace(/[\s_]/g, "");
}

function colRef(column: string): string {
  assertSqlIdent(TABLE_ALIAS, "table alias");
  const safe = column.replace(/"/g, '""');
  return `${TABLE_ALIAS}."${safe}"`;
}

function pickByKind(cols: SchemaColumnMeta[], kind: ColumnLogicalKind): SchemaColumnMeta[] {
  return cols.filter((c) => c.logical_classification === kind);
}

function pickBestVoterId(cols: SchemaColumnMeta[]): SchemaColumnMeta | null {
  const m = pickByKind(cols, "voter_id_candidate");
  if (!m.length) return null;
  const rank = (c: SchemaColumnMeta): number => {
    const n = normCompact(c.column_name);
    if (c.column_name === "voter_id" || n === "voterid") return 50;
    if (n.includes("voterfile")) return 45;
    if (n === "registrationnumber" || n === "registrationid" || n === "vrn") return 40;
    if (n === "id") return 25;
    return 30;
  };
  return [...m].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

function pickFirst(cols: SchemaColumnMeta[], kind: ColumnLogicalKind): SchemaColumnMeta | null {
  const m = pickByKind(cols, kind);
  return m[0] ?? null;
}

function dateLikeConfidence(dataType: string): MatchSourcePlanConfidence {
  const d = dataType.toLowerCase();
  if (d === "date") return "high";
  if (d.includes("timestamp")) return "high";
  if (d === "text" || d === "character varying" || d === "character") return "medium";
  return "low";
}

function voterIdConfidence(col: SchemaColumnMeta): MatchSourcePlanConfidence {
  const n = normCompact(col.column_name);
  if (col.column_name === "id" || n === "id") return "medium";
  return "high";
}

function relatedHints(discovery: DiscoverVoterSchemaResult): string[] {
  const warnings: string[] = [];
  const canon = discovery.columns;
  const has = (kind: ColumnLogicalKind) => canon.some((c) => c.logical_classification === kind);
  const keyKinds: ColumnLogicalKind[] = [
    "birth_date_candidate",
    "birth_year_candidate",
    "address_candidate",
    "city_candidate",
    "zip_candidate",
    "county_candidate",
    "ward_candidate",
    "precinct_candidate",
    "district_candidate",
  ];
  for (const rt of discovery.related_tables ?? []) {
    for (const c of rt.columns) {
      if (c.logical_classification === "unknown") continue;
      if (!keyKinds.includes(c.logical_classification)) continue;
      if (has(c.logical_classification)) continue;
      warnings.push(
        `Related table ${rt.qualified_table} column "${c.column_name}" looks like ${c.logical_classification}; canonical table lacks a clear match — review joins manually (name-only signal).`
      );
    }
  }
  return warnings.slice(0, 12);
}

function entry(
  expr: string | null,
  confidence: MatchSourcePlanConfidence,
  notes: string[] = []
): MatchSourcePlanColumnEntry {
  return { source_expression: expr, confidence, notes };
}

export function planFromDiscovery(
  discovery: DiscoverVoterSchemaResult,
  canonicalQualified: string,
  targetMatchSource: string
): MatchSourcePlanJson {
  const cols = discovery.columns;
  const warnings: string[] = [...relatedHints(discovery)];

  const vid = pickBestVoterId(cols);
  const fn = pickFirst(cols, "first_name_candidate");
  const ln = pickFirst(cols, "last_name_candidate");
  const full = pickFirst(cols, "full_name_candidate");
  const bd = pickFirst(cols, "birth_date_candidate");
  const by = pickFirst(cols, "birth_year_candidate");
  const addr = pickFirst(cols, "address_candidate");
  const city = pickFirst(cols, "city_candidate");
  const county = pickFirst(cols, "county_candidate");
  const st = pickFirst(cols, "state_candidate");
  const zip = pickFirst(cols, "zip_candidate");
  const ward = pickFirst(cols, "ward_candidate");
  const precinct = pickFirst(cols, "precinct_candidate");
  const district = pickFirst(cols, "district_candidate");
  const upd = pickFirst(cols, "updated_at_candidate");

  if (pickByKind(cols, "voter_id_candidate").length > 1) {
    warnings.push("Multiple voter_id_candidate columns on canonical table; picked highest-priority guess — verify.");
  }
  if (!fn && !full) {
    warnings.push("No first_name_candidate or full_name_candidate on canonical table.");
  }
  if (!ln && !full) {
    warnings.push("No last_name_candidate or full_name_candidate on canonical table.");
  }
  if (full && (!fn || !ln)) {
    warnings.push(
      `A full_name column ("${full.column_name}") was detected; split into first/last in SQL manually if there is no separate first/last columns.`
    );
  }

  const standard_columns: Record<string, MatchSourcePlanColumnEntry> = {};
  const stdCols = getStandardMatchColumns();

  const set = (key: string, e: MatchSourcePlanColumnEntry) => {
    standard_columns[key] = e;
  };

  if (vid) {
    set("voter_id", entry(`${colRef(vid.column_name)}::text`, voterIdConfidence(vid), []));
  } else {
    set("voter_id", entry(null, "missing", ["No voter_id_candidate column detected."]));
  }

  if (fn) {
    set("first_name", entry(`${colRef(fn.column_name)}::text`, "high", []));
  } else {
    set("first_name", entry(null, "missing", ["Map manually or split full_name."]));
  }

  if (ln) {
    set("last_name", entry(`${colRef(ln.column_name)}::text`, "high", []));
  } else {
    set("last_name", entry(null, "missing", ["Map manually or split full_name."]));
  }

  set(
    "first_name_norm",
    entry(
      null,
      fn ? "high" : "missing",
      fn ? ["Emitter will derive from first_name expression."] : ["Requires first_name mapping."]
    )
  );
  set(
    "last_name_norm",
    entry(
      null,
      ln ? "high" : "missing",
      ln ? ["Emitter will derive from last_name expression."] : ["Requires last_name mapping."]
    )
  );

  if (bd) {
    const conf = dateLikeConfidence(bd.data_type);
    set("birth_date", entry(`${colRef(bd.column_name)}::date`, conf, []));
  } else {
    set("birth_date", entry(null, "missing", ["TODO: map DOB from canonical or joined table."]));
  }

  if (by) {
    const conf = by.data_type.toLowerCase().includes("int") ? "high" : "medium";
    set("birth_year", entry(`${colRef(by.column_name)}::integer`, conf, []));
  } else {
    set("birth_year", entry(null, "missing", ["TODO: map birth year if available."]));
  }

  if (addr) {
    set("address", entry(`${colRef(addr.column_name)}::text`, "medium", []));
  } else {
    set("address", entry(null, "missing", ["TODO: map residential or mailing address."]));
  }
  set(
    "address_norm",
    entry(
      null,
      addr ? "high" : "missing",
      addr ? ["Emitter will derive from address expression."] : ["Requires address mapping."]
    )
  );

  if (city) {
    set("city", entry(`${colRef(city.column_name)}::text`, "high", []));
  } else {
    set("city", entry(null, "missing", ["TODO: map city."]));
  }
  set(
    "city_norm",
    entry(
      null,
      city ? "high" : "missing",
      city ? ["Emitter will derive from city expression."] : ["Requires city mapping."]
    )
  );

  if (county) {
    set("county", entry(`${colRef(county.column_name)}::text`, "medium", []));
  } else {
    set("county", entry(null, "missing", ["TODO: map county if present in source."]));
  }
  set(
    "county_norm",
    entry(
      null,
      county ? "high" : "missing",
      county ? ["Emitter will derive from county expression."] : ["Optional: map county for stronger geography signals."]
    )
  );

  if (st) {
    set("state", entry(`${colRef(st.column_name)}::text`, "high", []));
  } else {
    set("state", entry(null, "missing", ["TODO: map state / state code."]));
  }

  if (zip) {
    set("zip", entry(`${colRef(zip.column_name)}::text`, "high", []));
  } else {
    set("zip", entry(null, "missing", ["TODO: map ZIP / postal code."]));
  }
  set(
    "zip5",
    entry(
      null,
      zip ? "high" : "missing",
      zip ? ["Emitter will derive 5-digit zip from zip expression."] : ["Requires zip mapping."]
    )
  );

  if (ward) {
    set("ward", entry(`${colRef(ward.column_name)}::text`, "medium", []));
    set("ward_norm", entry(null, "high", ["Emitter will derive normalized ward text when ward is mapped."]));
  } else {
    set("ward", entry(null, "missing", ["Optional: map ward / council district for reporting."]));
    set("ward_norm", entry(null, "missing", []));
  }

  if (precinct) {
    set("precinct", entry(`${colRef(precinct.column_name)}::text`, "medium", []));
    set("precinct_norm", entry(null, "high", ["Emitter will derive normalized precinct when precinct is mapped."]));
  } else {
    set("precinct", entry(null, "missing", ["Optional precinct for reporting."]));
    set("precinct_norm", entry(null, "missing", []));
  }

  if (district) {
    set("district", entry(`${colRef(district.column_name)}::text`, "medium", []));
    set("district_norm", entry(null, "high", ["Emitter will derive normalized district when district is mapped."]));
  } else {
    set("district", entry(null, "missing", ["Optional district for reporting."]));
    set("district_norm", entry(null, "missing", []));
  }

  if (upd) {
    set("source_updated_at", entry(`${colRef(upd.column_name)}::timestamptz`, "medium", []));
  } else {
    set(
      "source_updated_at",
      entry(null, "missing", ["Emitter will use now()::timestamptz when expression is absent."])
    );
  }

  set(
    "source_metadata",
    entry(null, "high", [`Emitter will use jsonb_build_object('source_table', '<escaped>') for "${canonicalQualified}".`])
  );

  for (const k of stdCols) {
    if (!standard_columns[k]) {
      set(k, entry(null, "missing", ["Unmapped in planner."]));
    }
  }

  const missing_or_low_confidence: MatchSourcePlanJson["missing_or_low_confidence"] = [];
  for (const [name, v] of Object.entries(standard_columns)) {
    if (v.confidence === "missing" || v.confidence === "low") {
      missing_or_low_confidence.push({ standard_column: name, confidence: v.confidence, notes: v.notes });
    }
    if (v.confidence === "medium" && ["voter_id", "birth_date", "birth_year", "address"].includes(name)) {
      missing_or_low_confidence.push({
        standard_column: name,
        confidence: "medium",
        notes: [...v.notes, "Review cast and nullability."],
      });
    }
  }

  return {
    created_at: new Date().toISOString(),
    canonical_table: canonicalQualified,
    target_match_source: targetMatchSource,
    standard_columns,
    missing_or_low_confidence,
    warnings,
    operator_notes: [
      "Review this plan before generating or applying SQL.",
      "No row data was inspected — only information_schema metadata and column names.",
      "Joins to related tables are never auto-applied; edit expressions manually if needed.",
    ],
  };
}

export async function buildMatchSourcePlan(
  pool: Pool,
  opts: { canonicalQualified: string; targetMatchSource: string; includeRelated: boolean }
): Promise<MatchSourcePlanJson> {
  const discovery = await discoverVoterSchema(pool, opts.canonicalQualified, opts.includeRelated);
  return planFromDiscovery(discovery, opts.canonicalQualified, opts.targetMatchSource);
}
