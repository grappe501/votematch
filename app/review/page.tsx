import Link from "next/link";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { fetchReviewLandingData } from "@/tools/voter-file-matcher/src/webReview";
import { serverReviewAccessAllowed } from "@/lib/operatorAuth.server";
import { getTokenFromSearchParams, withReviewToken } from "@/lib/reviewOperatorToken";
import { ProtectedOperatorNotice } from "./components/ProtectedOperatorNotice";
import { SimpleTable } from "../reports/components/SimpleTable";

export const dynamic = "force-dynamic";

export default async function ReviewLandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const allowed = await serverReviewAccessAllowed(sp);
  if (!allowed) {
    return <ProtectedOperatorNotice />;
  }
  const token = getTokenFromSearchParams(sp);

  loadVfmEnv();
  const pool = createPool();
  let data: Awaited<ReturnType<typeof fetchReviewLandingData>> | null = null;
  let err: string | null = null;
  try {
    data = await fetchReviewLandingData(pool);
  } catch (e) {
    err = e instanceof Error ? e.message : "Could not load review dashboard.";
  } finally {
    await pool.end().catch(() => undefined);
  }

  return (
    <main className="page">
      <div className="page-hero">
        <h1>Operator review</h1>
        <p className="muted-p">
          Protected area: batches and initiatives with rows still in the review queue. Links preserve your access token
          for navigation only—do not share URLs.
        </p>
      </div>

      {err && <div className="banner danger">{err}</div>}

      {data && !data.migration_ok && (
        <div className="banner danger">
          Review tables are not installed. Apply migrations through 007 (initiative_review_queue_80).
        </div>
      )}

      {data && data.migration_ok && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Queue totals</h2>
            <div className="metric-grid">
              <div className="metric-cell">
                <div className="metric-label">Unresolved</div>
                <div className="metric-value">{data.counts.unresolved_total.toLocaleString()}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">Under 80%</div>
                <div className="metric-value">{data.counts.under_80.toLocaleString()}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">Not found</div>
                <div className="metric-value">{data.counts.not_found.toLocaleString()}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">Multiple</div>
                <div className="metric-value">{data.counts.multiple_matches.toLocaleString()}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">Weak</div>
                <div className="metric-value">{data.counts.weak_matches.toLocaleString()}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">Out of jurisdiction</div>
                <div className="metric-value">{data.counts.out_of_jurisdiction.toLocaleString()}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">Duplicate flags</div>
                <div className="metric-value">{data.counts.possible_duplicates.toLocaleString()}</div>
              </div>
              <div className="metric-cell">
                <div className="metric-label">Needs more info</div>
                <div className="metric-value">{data.counts.needs_more_info.toLocaleString()}</div>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Batches with open review</h2>
            <SimpleTable
              columns={[
                { key: "b", label: "Batch" },
                { key: "p", label: "Petition" },
                { key: "f", label: "File" },
                { key: "n", label: "Open rows", align: "right" },
                { key: "a", label: "" },
              ]}
              empty="No unresolved review rows."
              rows={data.batches.map((b) => ({
                b: <code style={{ fontSize: "0.75rem" }}>{b.import_batch_id.slice(0, 8)}…</code>,
                p: b.petition_code ?? "—",
                f: b.file_name ?? "—",
                n: b.unresolved.toLocaleString(),
                a: (
                  <Link className="link-button" href={withReviewToken(`/review/${b.import_batch_id}`, token)}>
                    Open batch review
                  </Link>
                ),
              }))}
            />
          </div>

          <div className="card">
            <h2>Initiatives with open review</h2>
            <SimpleTable
              columns={[
                { key: "c", label: "Petition code" },
                { key: "n", label: "Open rows", align: "right" },
              ]}
              empty="No initiatives with queue rows."
              rows={data.initiatives.map((x) => ({
                c: x.petition_code,
                n: x.unresolved.toLocaleString(),
              }))}
            />
          </div>
        </>
      )}
    </main>
  );
}
