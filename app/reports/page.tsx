import Link from "next/link";
import { createPool } from "../../tools/voter-file-matcher/src/db";
import { fetchDashboardRollups, fetchOrgKeys } from "../../tools/voter-file-matcher/src/dashboardSnapshots";
import { loadVfmEnv } from "../../tools/voter-file-matcher/src/env-load";
import { ConfidenceBar } from "./components/ConfidenceBar";
import { MetricCard } from "./components/MetricCard";
import { SimpleTable } from "./components/SimpleTable";
import { StatusBadge } from "./components/StatusBadge";

export const dynamic = "force-dynamic";

type Search = { org?: string };

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

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const orgRaw = sp.org?.trim();
  const org = orgRaw && orgRaw.length > 0 ? orgRaw : null;

  loadVfmEnv();
  let error: string | null = null;
  let orgs: string[] = [];
  let data: Awaited<ReturnType<typeof fetchDashboardRollups>> | null = null;

  try {
    const pool = createPool();
    try {
      orgs = await fetchOrgKeys(pool);
      data = await fetchDashboardRollups(pool, { org });
    } finally {
      await pool.end().catch(() => undefined);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not load reporting data.";
  }

  const t = data?.totals;

  return (
    <main className="page">
      <div className="page-hero">
        <h1>VoteMatch Reports</h1>
        <p>
          Aggregate import and match metrics for local review and Netlify demos. No raw signer names, addresses, or
          dates of birth are listed here—only counts and rollups. Filter by project key (organization) when you use
          multiple tenants in one database.
        </p>
      </div>

      {error && (
        <div className="banner danger">
          {error} For local development, point <code>VFM_DOTENV_PATH</code> at a file that defines{" "}
          <code>DATABASE_URL</code> (see <code>.env.example</code>). On Netlify, set <code>DATABASE_URL</code> in site
          environment variables—do not commit secrets.
        </div>
      )}

      {data && (
        <>
          {data.warnings.length > 0 && (
            <div className="banner">
              <strong>Migration / schema warnings</strong>
              <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
                {data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="card" style={{ marginBottom: "1rem" }}>
            <div className="reports-meta">
              <span>
                <strong>Generated</strong> {new Date(data.generated_at).toLocaleString()}
              </span>
              <span>
                <strong>Database</strong> {data.database_configured ? "configured" : "not configured"}
              </span>
              <span>
                <strong>Filter</strong> {org ?? "all project keys"}
              </span>
            </div>
            <p className="export-note">
              Detailed CSV reports are generated server-side under{" "}
              <code>tools/voter-file-matcher/reports/&lt;batch_id&gt;/</code> and should be accessed only by authorized
              operators. This web app does not stream those files.
            </p>
          </div>

          <div className="tabbar">
            <Link href="/reports" className={`tab${org == null ? " active" : ""}`}>
              All orgs
            </Link>
            {orgs.map((k) => (
              <Link key={k} href={`/reports?org=${encodeURIComponent(k)}`} className={`tab${org === k ? " active" : ""}`}>
                {k}
              </Link>
            ))}
          </div>

          {t && (
            <div className="metric-grid">
              <MetricCard label="Total import rows" value={fmtInt(t.total_import_rows)} hint="Rows staged from files." />
              <MetricCard label="Matched (import)" value={fmtInt(t.matched_total)} />
              <MetricCard label="Not matched" value={fmtInt(t.not_found_total)} hint="NOT_FOUND status on import rows." />
              <MetricCard label="Under 80% confidence" value={fmtInt(t.under_80_total)} />
              <MetricCard label="Needs review (queue)" value={fmtInt(t.needs_review_total)} />
              <MetricCard label="Nonvoter file entries" value={fmtInt(t.nonvoter_total)} />
              <MetricCard label="Out of jurisdiction" value={fmtInt(t.out_of_jurisdiction_total)} />
              <MetricCard label="Duplicate flags" value={fmtInt(t.duplicate_total)} />
              <MetricCard label="Multiple matches" value={fmtInt(t.multiple_matches_total)} />
              <MetricCard label="Weak matches" value={fmtInt(t.weak_matches_total)} />
              <MetricCard label="Errors" value={fmtInt(t.error_total)} />
              <MetricCard label="Import batches" value={fmtInt(t.total_batches)} />
              <MetricCard label="Avg confidence (import)" value={fmtPct(t.avg_confidence_pct)} />
            </div>
          )}

          <div className="card">
            <h2>Initiatives</h2>
            <p className="muted-p" style={{ marginBottom: "0.75rem" }}>
              Permanent signature rows per petition (not raw import staging rows).
            </p>
            <SimpleTable
              columns={[
                { key: "code", label: "Code" },
                { key: "name", label: "Name" },
                { key: "scope", label: "Scope" },
                { key: "geo", label: "Reporting geo" },
                { key: "total", label: "Total sigs", align: "right" },
                { key: "valid", label: "Valid in-jurisdiction", align: "right" },
                { key: "review", label: "Needs review", align: "right" },
                { key: "nv", label: "Nonvoters", align: "right" },
                { key: "avg", label: "Avg conf.", align: "right" },
                { key: "target", label: "Target progress", align: "right" },
                { key: "link", label: "" },
              ]}
              empty="No petitions in this filter yet."
              rows={data.initiatives.map((r) => {
                const target = r.target_signature_count;
                const progress =
                  target != null && target > 0 ? `${fmtInt(r.total_signatures)} / ${fmtInt(target)}` : "—";
                return {
                  code: <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>{r.petition_code}</span>,
                  name: r.petition_name,
                  scope: r.initiative_scope ?? "—",
                  geo: r.reporting_geo ?? "—",
                  total: fmtInt(r.total_signatures),
                  valid: fmtInt(r.valid_in_jurisdiction_signatures),
                  review: fmtInt(r.needs_review_total),
                  nv: fmtInt(r.nonvoter_total),
                  avg: fmtPct(r.avg_confidence_pct),
                  target: progress,
                  link: (
                    <Link href={`/initiatives/${encodeURIComponent(r.petition_code)}`}>Detail</Link>
                  ),
                };
              })}
            />
          </div>

          <div className="card">
            <h2>Recent import batches (last 50)</h2>
            <SimpleTable
              columns={[
                { key: "id", label: "Batch" },
                { key: "petition", label: "Petition" },
                { key: "file", label: "File" },
                { key: "rows", label: "Rows", align: "right" },
                { key: "m", label: "Matched", align: "right" },
                { key: "nf", label: "Not found", align: "right" },
                { key: "mm", label: "Multiple", align: "right" },
                { key: "wm", label: "Weak", align: "right" },
                { key: "err", label: "Errors", align: "right" },
                { key: "u80", label: "Under 80", align: "right" },
                { key: "rev", label: "Review", align: "right" },
                { key: "st", label: "Status" },
                { key: "created", label: "Created" },
                { key: "link", label: "" },
              ]}
              empty="No batches for this filter."
              rows={data.recent_batches.map((b) => ({
                id: (
                  <Link href={`/reports/${encodeURIComponent(b.batch_id)}`} title={b.batch_id} style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
                    {shortBatchId(b.batch_id)}
                  </Link>
                ),
                petition: b.petition_code ?? "—",
                file: b.file_name,
                rows: fmtInt(b.total_rows),
                m: fmtInt(b.matched),
                nf: fmtInt(b.not_found),
                mm: fmtInt(b.multiple_matches),
                wm: fmtInt(b.weak_matches),
                err: fmtInt(b.errors),
                u80: fmtInt(b.under_80),
                rev: fmtInt(b.needs_review),
                st: <StatusBadge status={b.status} />,
                created: <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{b.created_at}</span>,
                link: (
                  <Link href={`/reports/${encodeURIComponent(b.batch_id)}`}>Detail</Link>
                ),
              }))}
            />
          </div>

          <div className="card">
            <h2>Confidence distribution (import matches)</h2>
            <ConfidenceBar distribution={data.confidence_distribution} />
          </div>

          <div className="card">
            <h2>Biggest problem categories</h2>
            <SimpleTable
              columns={[
                { key: "p", label: "Problem" },
                { key: "c", label: "Count", align: "right" },
              ]}
              rows={data.problem_counts.map((x) => ({
                p: x.problem,
                c: fmtInt(x.count),
              }))}
            />
          </div>

          {data.ward_counts.length > 0 && (
            <div className="card">
              <h2>Ward rollups</h2>
              <p className="muted-p" style={{ marginBottom: "0.75rem" }}>
                From initiative ward reporting (city ward initiatives). Aggregate counts only.
              </p>
              <SimpleTable
                columns={[
                  { key: "pc", label: "Petition code" },
                  { key: "w", label: "Ward" },
                  { key: "n", label: "Signatures", align: "right" },
                  { key: "a", label: "Avg confidence", align: "right" },
                ]}
                rows={data.ward_counts.map((r) => ({
                  pc: r.petition_code,
                  w: r.ward ?? "—",
                  n: fmtInt(r.total_signatures),
                  a: fmtPct(r.avg_confidence_pct),
                }))}
              />
            </div>
          )}

          {data.county_counts.length > 0 && (
            <div className="card">
              <h2>County rollups</h2>
              <p className="muted-p" style={{ marginBottom: "0.75rem" }}>
                From county or statewide reporting views. Aggregate counts only.
              </p>
              <SimpleTable
                columns={[
                  { key: "pc", label: "Petition code" },
                  { key: "co", label: "County" },
                  { key: "n", label: "Signatures", align: "right" },
                  { key: "a", label: "Avg confidence", align: "right" },
                ]}
                rows={data.county_counts.map((r) => ({
                  pc: r.petition_code,
                  co: r.county ?? "—",
                  n: fmtInt(r.total_signatures),
                  a: fmtPct(r.avg_confidence_pct),
                }))}
              />
            </div>
          )}
        </>
      )}
    </main>
  );
}
