import Link from "next/link";
import { notFound } from "next/navigation";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { fetchBatchReportSnapshot } from "@/tools/voter-file-matcher/src/dashboardSnapshots";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import { fetchReviewQueueTableRows, safeRunReviewProgress } from "@/tools/voter-file-matcher/src/webReview";
import { serverReviewAccessAllowed } from "@/lib/operatorAuth.server";
import { getTokenFromSearchParams, withReviewToken } from "@/lib/reviewOperatorToken";
import { ProtectedOperatorNotice } from "../components/ProtectedOperatorNotice";
import { ReviewProgressPanel } from "../components/ReviewProgressPanel";
import { ReviewNextClient } from "../components/ReviewNextClient";
import { ReviewQueueTable } from "../components/ReviewQueueTable";

export const dynamic = "force-dynamic";

export default async function ReviewBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const allowed = await serverReviewAccessAllowed(sp);
  if (!allowed) {
    return <ProtectedOperatorNotice />;
  }
  const token = getTokenFromSearchParams(sp);
  const { batchId: raw } = await params;
  const batchId = decodeURIComponent(raw).trim();
  if (!isValidUuid(batchId)) notFound();

  loadVfmEnv();
  const pool = createPool();
  let snap: Awaited<ReturnType<typeof fetchBatchReportSnapshot>> = null;
  let queueRows: Awaited<ReturnType<typeof fetchReviewQueueTableRows>> = [];
  let progress: Awaited<ReturnType<typeof safeRunReviewProgress>> = null;
  let loadError: string | null = null;
  try {
    snap = await fetchBatchReportSnapshot(pool, batchId);
    queueRows = await fetchReviewQueueTableRows(pool, batchId, 250);
    progress = await safeRunReviewProgress(pool, batchId);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Could not load batch.";
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (loadError) {
    return (
      <main className="page">
        <div className="banner danger">{loadError}</div>
        <Link href={withReviewToken("/review", token)}>← Review home</Link>
      </main>
    );
  }
  if (!snap) notFound();

  return (
    <main className="page">
      <p style={{ margin: "0 0 1rem" }}>
        <Link href={withReviewToken("/review", token)}>← Review home</Link>
        {" · "}
        <Link href={`/reports/batches/${encodeURIComponent(batchId)}`}>Batch report (aggregate)</Link>
      </p>
      <div className="page-hero">
        <h1>Batch review queue</h1>
        <p className="muted-p" style={{ margin: 0 }}>
          <code>{snap.batch_id}</code> · {snap.petition_code ?? "—"} · {snap.file_name}
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

      <ReviewProgressPanel progress={progress} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Actions</h2>
        <ReviewNextClient batchId={batchId} token={token} />
      </div>

      <div className="card">
        <h2>Rows needing review</h2>
        <p className="muted-p" style={{ marginTop: 0 }}>
          Limited columns in the table; open a row for full signer and candidate detail.
        </p>
        <ReviewQueueTable batchId={batchId} rows={queueRows} token={token} />
      </div>
    </main>
  );
}
