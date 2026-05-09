import Link from "next/link";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { listInitiativesForReports } from "@/tools/voter-file-matcher/src/webReports";
import { SimpleTable } from "../components/SimpleTable";

export const dynamic = "force-dynamic";

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

function fmtPct(n: number | null) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

export default async function InitiativesReportListPage() {
  loadVfmEnv();
  const pool = createPool();
  let rows: Awaited<ReturnType<typeof listInitiativesForReports>>["rows"] = [];
  let warnings: string[] = [];
  let err: string | null = null;
  try {
    const r = await listInitiativesForReports(pool);
    rows = r.rows;
    warnings = r.warnings;
  } catch (e) {
    err = e instanceof Error ? e.message : "Could not load initiatives.";
  } finally {
    await pool.end().catch(() => undefined);
  }

  return (
    <main className="page">
      <p style={{ margin: "0 0 1rem" }}>
        <Link href="/reports">← Reports hub</Link>
      </p>
      <div className="page-hero">
        <h1>Initiatives</h1>
        <p className="muted-p">Aggregate signature and review metrics—no signer-level PII.</p>
      </div>

      {err && <div className="banner danger">{err}</div>}
      {warnings.length > 0 && (
        <div className="banner">
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <SimpleTable
          columns={[
            { key: "code", label: "Code" },
            { key: "name", label: "Name" },
            { key: "scope", label: "Scope" },
            { key: "j", label: "Jurisdiction" },
            { key: "geo", label: "Reporting" },
            { key: "tgt", label: "Target", align: "right" },
            { key: "tot", label: "Sigs", align: "right" },
            { key: "val", label: "Valid in-j", align: "right" },
            { key: "rev", label: "Review", align: "right" },
            { key: "u80", label: "Under 80", align: "right" },
            { key: "nv", label: "Nonvoters", align: "right" },
            { key: "dup", label: "Dups", align: "right" },
            { key: "avg", label: "Avg conf", align: "right" },
            { key: "pr", label: "Progress", align: "right" },
            { key: "lnk", label: "" },
          ]}
          empty="No initiatives."
          rows={rows.map((r) => {
            const tgt = r.target_signature_count;
            const progress =
              tgt != null && tgt > 0 ? `${fmt(r.total_signatures)} / ${fmt(tgt)}` : "—";
            return {
              code: <code style={{ fontSize: "0.78rem" }}>{r.petition_code}</code>,
              name: r.petition_name,
              scope: r.initiative_scope ?? "—",
              j: r.jurisdiction_label ?? "—",
              geo: r.reporting_geo ?? "—",
              tgt: tgt != null ? fmt(tgt) : "—",
              tot: fmt(r.total_signatures),
              val: fmt(r.valid_in_jurisdiction),
              rev: fmt(r.needs_review),
              u80: fmt(r.under_80),
              nv: fmt(r.nonvoters),
              dup: fmt(r.duplicates),
              avg: fmtPct(r.avg_confidence_pct),
              pr: progress,
              lnk: (
                <Link href={`/reports/initiatives/${encodeURIComponent(r.petition_code)}`}>Detail</Link>
              ),
            };
          })}
        />
      </div>
    </main>
  );
}
