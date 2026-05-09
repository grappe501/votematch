import Link from "next/link";
import { notFound } from "next/navigation";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { fetchBatchReportSnapshot } from "@/tools/voter-file-matcher/src/dashboardSnapshots";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import { ConfidenceBar } from "../../components/ConfidenceBar";
import { SimpleTable } from "../../components/SimpleTable";
import { StatusBadge } from "../../components/StatusBadge";

export const dynamic = "force-dynamic";

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtPct(n: number | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

export default async function BatchReportDetailPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId: raw } = await params;
  const batchId = decodeURIComponent(raw).trim();
  if (!isValidUuid(batchId)) notFound();

  loadVfmEnv();
  const pool = createPool();
  let snap: Awaited<ReturnType<typeof fetchBatchReportSnapshot>> = null;
  let loadError: string | null = null;
  try {
    snap = await fetchBatchReportSnapshot(pool, batchId);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Could not load batch.";
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (loadError) {
    return (
      <main className="page">
        <div className="banner danger">{loadError}</div>
        <Link href="/reports/batches">← Batches</Link>
      </main>
    );
  }

  if (!snap) notFound();

  const rp = snap.review_progress;

  return (
    <main className="page">
      <p style={{ margin: "0 0 1rem" }}>
        <Link href="/reports">Reports</Link> · <Link href="/reports/batches">Batches</Link>
      </p>
      <div className="page-hero">
        <h1>Import batch</h1>
        <p className="reports-meta" style={{ margin: 0 }}>
          <span>
            <strong>Batch ID</strong> <code style={{ fontSize: "0.85rem" }}>{snap.batch_id}</code>
          </span>
          <span>
            <strong>Status</strong> <StatusBadge status={snap.status} />
          </span>
        </p>
      </div>

      {snap.warnings.length > 0 && (
        <div className="banner">
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {snap.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Operator review</h2>
        <p className="muted-p">
          Row-level review is protected. Open <Link href={`/review/${encodeURIComponent(batchId)}`}>batch review queue</Link>{" "}
          with <code>?token=…</code> or operator cookie.
        </p>
      </div>

      {rp && (
        <div className="card">
          <h2>Review progress</h2>
          <SimpleTable
            columns={[
              { key: "k", label: "Metric" },
              { key: "v", label: "Value", align: "right" },
            ]}
            rows={[
              { k: "Total rows (report view)", v: fmtInt(rp.total_rows) },
              { k: "Unresolved review rows", v: fmtInt(rp.unresolved_review_rows) },
              { k: "Percent complete", v: `${rp.percent_complete.toFixed(1)}%` },
              { k: "Manual approvals", v: fmtInt(rp.manually_approved) },
              { k: "Rejected", v: fmtInt(rp.rejected) },
              { k: "Needs more info", v: fmtInt(rp.needs_more_info) },
            ]}
          />
        </div>
      )}

      <div className="card">
        <h2>Metadata</h2>
        <SimpleTable
          columns={[
            { key: "k", label: "Field" },
            { key: "v", label: "Value" },
          ]}
          rows={[
            { k: "File name", v: snap.file_name },
            { k: "Project key", v: snap.project_key },
            { k: "Petition code", v: snap.petition_code ?? "—" },
            { k: "Created", v: snap.created_at },
            { k: "Completed", v: snap.completed_at ?? "—" },
          ]}
        />
      </div>

      <div className="card">
        <h2>Aggregate counts</h2>
        <SimpleTable
          columns={[
            { key: "m", label: "Metric" },
            { key: "c", label: "Count", align: "right" },
          ]}
          rows={[
            { m: "Total rows (batch header)", c: fmtInt(snap.total_rows) },
            { m: "Matched", c: fmtInt(snap.matched) },
            { m: "Not found", c: fmtInt(snap.not_found) },
            { m: "Multiple matches", c: fmtInt(snap.multiple_matches) },
            { m: "Weak matches", c: fmtInt(snap.weak_matches) },
            { m: "Errors", c: fmtInt(snap.errors) },
            { m: "Under 80% confidence", c: fmtInt(snap.under_80) },
            { m: "Needs review (queue)", c: fmtInt(snap.needs_review) },
            { m: "Out of jurisdiction", c: fmtInt(snap.out_of_jurisdiction) },
            { m: "Duplicate flags", c: fmtInt(snap.duplicates) },
            { m: "Nonvoter entries (batch)", c: fmtInt(snap.nonvoters) },
          ]}
        />
      </div>

      <div className="card">
        <h2>Confidence distribution</h2>
        <ConfidenceBar distribution={snap.confidence_distribution} />
      </div>

      <div className="card">
        <h2>Problem counts</h2>
        <SimpleTable
          columns={[
            { key: "p", label: "Problem" },
            { key: "c", label: "Count", align: "right" },
          ]}
          rows={snap.problem_counts.map((x) => ({ p: x.problem, c: fmtInt(x.count) }))}
        />
      </div>

      {snap.ward_counts.length > 0 && (
        <div className="card">
          <h2>Ward counts (this batch)</h2>
          <p className="muted-p" style={{ marginBottom: "0.75rem" }}>
            Aggregated from permanent signatures linked to this batch—no signer PII.
          </p>
          <SimpleTable
            columns={[
              { key: "w", label: "Ward" },
              { key: "n", label: "Signatures", align: "right" },
              { key: "a", label: "Avg confidence", align: "right" },
            ]}
            rows={snap.ward_counts.map((r) => ({
              w: r.ward ?? "—",
              n: fmtInt(r.total_signatures),
              a: fmtPct(r.avg_confidence_pct),
            }))}
          />
        </div>
      )}

      {snap.county_counts.length > 0 && (
        <div className="card">
          <h2>County counts (this batch)</h2>
          <SimpleTable
            columns={[
              { key: "co", label: "County" },
              { key: "n", label: "Signatures", align: "right" },
              { key: "a", label: "Avg confidence", align: "right" },
            ]}
            rows={snap.county_counts.map((r) => ({
              co: r.county ?? "—",
              n: fmtInt(r.total_signatures),
              a: fmtPct(r.avg_confidence_pct),
            }))}
          />
        </div>
      )}

      <p className="export-note">
        Operator CSV exports live under <code>tools/voter-file-matcher/reports/{snap.batch_id}/</code>—not served by this
        app.
      </p>
    </main>
  );
}
