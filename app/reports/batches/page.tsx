import Link from "next/link";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isValidPetitionCode, listReportBatches } from "@/tools/voter-file-matcher/src/webReports";
import { SimpleTable } from "../components/SimpleTable";
import { StatusBadge } from "../components/StatusBadge";

export const dynamic = "force-dynamic";

function shortId(id: string) {
  return id.length >= 8 ? `${id.slice(0, 8)}…` : id;
}

export default async function ReportBatchesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const petitionRaw = typeof sp.petition_code === "string" ? sp.petition_code : Array.isArray(sp.petition_code) ? sp.petition_code[0] : undefined;
  const statusRaw = typeof sp.status === "string" ? sp.status : Array.isArray(sp.status) ? sp.status[0] : undefined;
  const needsRaw = typeof sp.needs_review === "string" ? sp.needs_review : Array.isArray(sp.needs_review) ? sp.needs_review[0] : undefined;
  const petition_code = petitionRaw?.trim() || null;
  const status = statusRaw?.trim() || null;
  const needs_review_only = needsRaw === "1" || needsRaw === "true";

  loadVfmEnv();
  const pool = createPool();
  let rows: Awaited<ReturnType<typeof listReportBatches>>["rows"] = [];
  let warnings: string[] = [];
  let err: string | null = null;
  try {
    const r = await listReportBatches(pool, {
      petition_code: petition_code && isValidPetitionCode(petition_code) ? petition_code : null,
      status,
      needs_review_only,
      limit: 250,
    });
    rows = r.rows;
    warnings = r.warnings;
  } catch (e) {
    err = e instanceof Error ? e.message : "Could not load batches.";
  } finally {
    await pool.end().catch(() => undefined);
  }

  const q = (extra: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    if (petition_code) u.set("petition_code", petition_code);
    if (status) u.set("status", status);
    if (needs_review_only || extra.needs_review === "1") u.set("needs_review", "1");
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || k === "needs_review") continue;
      u.set(k, v);
    }
    const s = u.toString();
    return s ? `?${s}` : "";
  };

  return (
    <main className="page">
      <p style={{ margin: "0 0 1rem" }}>
        <Link href="/reports">← Reports hub</Link>
      </p>
      <div className="page-hero">
        <h1>Import batches</h1>
        <p className="muted-p">Aggregate counts only—no signer names.</p>
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

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>Filters</h2>
        <form className="reports-filter-form" method="get" action="/reports/batches">
          <label>
            Petition code{" "}
            <input name="petition_code" type="text" defaultValue={petition_code ?? ""} placeholder="e.g. AJAX_…" />
          </label>
          <label>
            Status{" "}
            <input name="status" type="text" defaultValue={status ?? ""} placeholder="COMPLETED" />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" name="needs_review" value="1" defaultChecked={needs_review_only} />
            Needs review only
          </label>
          <button type="submit" className="btn primary">
            Apply
          </button>
        </form>
        <p className="muted-p" style={{ marginBottom: 0 }}>
          Quick: <Link href="/reports/batches?needs_review=1">needs review</Link>
        </p>
      </div>

      <div className="card">
        <SimpleTable
          columns={[
            { key: "id", label: "Batch" },
            { key: "pet", label: "Petition" },
            { key: "file", label: "File" },
            { key: "rows", label: "Rows", align: "right" },
            { key: "m", label: "Matched", align: "right" },
            { key: "u80", label: "Under 80", align: "right" },
            { key: "rev", label: "Review", align: "right" },
            { key: "nv", label: "Nonvoters", align: "right" },
            { key: "ooj", label: "OOJ", align: "right" },
            { key: "dup", label: "Dups", align: "right" },
            { key: "st", label: "Status" },
            { key: "created", label: "Created" },
            { key: "a", label: "" },
          ]}
          empty="No batches."
          rows={rows.map((b) => ({
            id: (
              <Link href={`/reports/batches/${encodeURIComponent(b.batch_id)}`} title={b.batch_id}>
                <code style={{ fontSize: "0.75rem" }}>{shortId(b.batch_id)}</code>
              </Link>
            ),
            pet: b.petition_code ?? "—",
            file: b.file_name,
            rows: b.total_rows.toLocaleString(),
            m: b.matched.toLocaleString(),
            u80: b.under_80.toLocaleString(),
            rev: b.needs_review.toLocaleString(),
            nv: b.nonvoters.toLocaleString(),
            ooj: b.out_of_jurisdiction.toLocaleString(),
            dup: b.duplicates.toLocaleString(),
            st: <StatusBadge status={b.status} />,
            created: <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{b.created_at}</span>,
            a: (
              <span style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                <Link className="link-button" href={`/reports/batches/${encodeURIComponent(b.batch_id)}`}>
                  Report
                </Link>
                <Link className="link-button" href={`/review/${encodeURIComponent(b.batch_id)}`}>
                  Review
                </Link>
              </span>
            ),
          }))}
        />
      </div>
    </main>
  );
}
