import Link from "next/link";
import { notFound } from "next/navigation";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import {
  ensureReviewCandidateSnapshotsForRow,
  fetchCandidatesForRowPageUi,
  fetchReviewQueueRow,
  resolveReviewCanonicalContext,
} from "@/tools/voter-file-matcher/src/webReview";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import { serverReviewAccessAllowed } from "@/lib/operatorAuth.server";
import { getTokenFromSearchParams, withReviewToken } from "@/lib/reviewOperatorToken";
import { ProtectedOperatorNotice } from "../../../components/ProtectedOperatorNotice";
import { ReviewRowClient } from "../../../components/ReviewRowClient";

export const dynamic = "force-dynamic";

export default async function ReviewRowPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string; rowNumber: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const allowed = await serverReviewAccessAllowed(sp);
  if (!allowed) {
    return <ProtectedOperatorNotice />;
  }
  const token = getTokenFromSearchParams(sp);
  const { batchId: rawBatch, rowNumber: rawRow } = await params;
  const batchId = decodeURIComponent(rawBatch).trim();
  const rowNumber = Number.parseInt(rawRow, 10);
  if (!isValidUuid(batchId) || !Number.isFinite(rowNumber) || rowNumber < 1) notFound();

  loadVfmEnv();
  const pool = createPool();
  let row = null as Awaited<ReturnType<typeof fetchReviewQueueRow>>;
  let candidates: Awaited<ReturnType<typeof fetchCandidatesForRowPageUi>> = [];
  let canonError: string | null = null;
  try {
    row = await fetchReviewQueueRow(pool, batchId, rowNumber);
    const canon = await resolveReviewCanonicalContext();
    if (!canon.ok) {
      canonError = canon.error;
    } else {
      const ensured = await ensureReviewCandidateSnapshotsForRow(pool, batchId, rowNumber, canon);
      if (!ensured.ok) {
        canonError = ensured.error;
      } else {
        candidates = await fetchCandidatesForRowPageUi(pool, batchId, rowNumber);
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (!row) {
    return (
      <main className="page">
        <div className="banner danger">
          Row not in review queue (resolved, invalid row, or migration 007 missing).
        </div>
        <Link href={withReviewToken(`/review/${batchId}`, token)}>← Back to batch queue</Link>
      </main>
    );
  }

  const queueUrl = withReviewToken(`/review/${batchId}`, token);
  const n = row.normalized_json;

  return (
    <main className="page review-row-page">
      <div className="review-row-sticky">
        <p style={{ margin: 0 }}>
          <Link href={withReviewToken("/review", token)}>Review home</Link>
          {" · "}
          <Link href={queueUrl}>Batch queue</Link>
        </p>
        <h1 style={{ margin: "0.25rem 0 0", fontSize: "1.25rem" }}>
          Row {rowNumber} · {row.match_status} · review {row.review_status}
        </h1>
      </div>

      {canonError && (
        <div className="banner danger" style={{ marginTop: "0.75rem" }}>
          {canonError}
        </div>
      )}

      <div className="review-row-grid">
        <section className="card signer-card">
          <h2 style={{ marginTop: 0 }}>Signer (import)</h2>
          <dl className="kv-list">
            <dt>Row</dt>
            <dd>{rowNumber}</dd>
            <dt>Name</dt>
            <dd>
              {row.signer_full_name ??
                ([row.signer_first_name, row.signer_last_name].filter(Boolean).join(" ") || "—")}
            </dd>
            <dt>Address</dt>
            <dd>{row.signer_address ?? "—"}</dd>
            <dt>City / State / ZIP</dt>
            <dd>
              {[row.signer_city, row.signer_state, row.signer_zip].filter(Boolean).join(", ") || "—"}
            </dd>
            <dt>Signed</dt>
            <dd>{row.signed_at ?? "—"}</dd>
            <dt>Birth (normalized)</dt>
            <dd>
              {[n.birth_month, n.birth_day, n.birth_year].filter((x) => x != null && String(x).trim() !== "").join("/") ||
                (n.birth_date ?? "—")}
            </dd>
            <dt>Notes</dt>
            <dd>{row.match_notes ?? "—"}</dd>
            <dt>QA flags</dt>
            <dd>{Array.isArray(n._qa_flags) ? n._qa_flags.join(", ") : "—"}</dd>
            <dt>Confidence</dt>
            <dd>{row.match_confidence_pct != null ? `${row.match_confidence_pct}%` : "—"}</dd>
            <dt>Jurisdiction</dt>
            <dd>{row.jurisdiction_status ?? "—"}</dd>
            <dt>Duplicate</dt>
            <dd>{row.duplicate_status ?? "—"}</dd>
          </dl>
        </section>

        <section className="card">
          <h2 style={{ marginTop: 0 }}>Voter candidates</h2>
          {candidates.length === 0 ? (
            <p className="muted-p">No candidates loaded. Fix configuration errors above or re-run matching.</p>
          ) : (
            <ReviewRowClient batchId={batchId} rowNumber={rowNumber} token={token} candidates={candidates} queueUrl={queueUrl} />
          )}
        </section>
      </div>
    </main>
  );
}
