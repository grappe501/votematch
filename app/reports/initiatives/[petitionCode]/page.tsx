import Link from "next/link";
import { notFound } from "next/navigation";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { fetchInitiativeReportSnapshot } from "@/tools/voter-file-matcher/src/dashboardSnapshots";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
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

function shortBatchId(id: string): string {
  return id.length >= 8 ? `${id.slice(0, 8)}…` : id;
}

export default async function InitiativeReportDetailPage({ params }: { params: Promise<{ petitionCode: string }> }) {
  const { petitionCode: raw } = await params;
  const petitionCode = decodeURIComponent(raw).trim();
  if (!petitionCode) notFound();

  loadVfmEnv();
  const pool = createPool();
  let snap: Awaited<ReturnType<typeof fetchInitiativeReportSnapshot>> = null;
  let loadError: string | null = null;
  try {
    snap = await fetchInitiativeReportSnapshot(pool, petitionCode);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Could not load initiative.";
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (loadError) {
    return (
      <main className="page">
        <div className="banner danger">{loadError}</div>
        <Link href="/reports/initiatives">← Initiatives</Link>
      </main>
    );
  }

  if (!snap) notFound();

  return (
    <main className="page">
      <p style={{ margin: "0 0 1rem" }}>
        <Link href="/reports">Reports</Link> · <Link href="/reports/initiatives">Initiatives</Link>
      </p>
      <div className="page-hero">
        <h1>{snap.petition_name}</h1>
        <p style={{ margin: 0, color: "var(--muted)" }}>
          <code>{snap.petition_code}</code>
          {snap.initiative_scope ? ` · ${snap.initiative_scope}` : ""}
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
          Use <Link href="/review">Review home</Link> with <code>?token=…</code> for signer-level queues.
        </p>
      </div>

      <div className="card">
        <h2>Jurisdiction & targets</h2>
        <SimpleTable
          columns={[
            { key: "k", label: "Field" },
            { key: "v", label: "Value" },
          ]}
          rows={[
            { k: "Reporting geo", v: snap.reporting_geo ?? "—" },
            { k: "Jurisdiction name", v: snap.jurisdiction_name ?? "—" },
            { k: "City", v: snap.jurisdiction_city ?? "—" },
            { k: "County", v: snap.jurisdiction_county ?? "—" },
            { k: "State", v: snap.jurisdiction_state ?? "—" },
            { k: "Jurisdiction type", v: snap.jurisdiction_type ?? "—" },
            {
              k: "Target signatures",
              v: snap.target_signature_count != null ? fmtInt(snap.target_signature_count) : "—",
            },
          ]}
        />
      </div>

      <div className="card">
        <h2>Signature & quality totals</h2>
        <SimpleTable
          columns={[
            { key: "m", label: "Metric" },
            { key: "c", label: "Count", align: "right" },
          ]}
          rows={[
            { m: "Total signatures (permanent table)", c: fmtInt(snap.total_signatures) },
            { m: "Valid in-jurisdiction", c: fmtInt(snap.valid_in_jurisdiction_signatures) },
            { m: "Needs review (queue)", c: fmtInt(snap.needs_review) },
            { m: "Nonvoter entries", c: fmtInt(snap.nonvoters) },
            { m: "Out of jurisdiction (import matches)", c: fmtInt(snap.out_of_jurisdiction) },
            { m: "Duplicate flags (import matches)", c: fmtInt(snap.duplicates) },
            { m: "Under 80% confidence (import matches)", c: fmtInt(snap.under_80) },
          ]}
        />
      </div>

      <div className="card">
        <h2>Confidence distribution (import matches)</h2>
        <ConfidenceBar distribution={snap.confidence_distribution} />
      </div>

      {snap.ward_counts.length > 0 && (
        <div className="card">
          <h2>Ward breakdown</h2>
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
          <h2>County breakdown</h2>
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

      <div className="card">
        <h2>Recent batches for this initiative</h2>
        <SimpleTable
          columns={[
            { key: "id", label: "Batch" },
            { key: "file", label: "File" },
            { key: "rows", label: "Rows", align: "right" },
            { key: "m", label: "Matched", align: "right" },
            { key: "nf", label: "Not found", align: "right" },
            { key: "st", label: "Status" },
            { key: "link", label: "" },
          ]}
          empty="No batches for this petition code."
          rows={snap.recent_batches.map((b) => ({
            id: (
              <Link
                href={`/reports/batches/${encodeURIComponent(b.batch_id)}`}
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}
              >
                {shortBatchId(b.batch_id)}
              </Link>
            ),
            file: b.file_name,
            rows: fmtInt(b.total_rows),
            m: fmtInt(b.matched),
            nf: fmtInt(b.not_found),
            st: <StatusBadge status={b.status} />,
            link: (
              <span style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                <Link href={`/reports/batches/${encodeURIComponent(b.batch_id)}`}>Report</Link>
                <Link href={`/review/${encodeURIComponent(b.batch_id)}`}>Review</Link>
              </span>
            ),
          }))}
        />
      </div>

      <p className="export-note">
        Detailed CSV reports are generated server-side under <code>tools/voter-file-matcher/reports/&lt;batch_id&gt;/</code>{" "}
        for authorized operators only.
      </p>
    </main>
  );
}
