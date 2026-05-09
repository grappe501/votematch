import Link from "next/link";
import { notFound } from "next/navigation";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { getOcrBatchMeta, getOcrBatchSummary } from "@/tools/voter-file-matcher/src/ocrPipeline";
import { getOcrReviewProgress } from "@/tools/voter-file-matcher/src/ocrReview";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isOcrPageAuthorized, readOcrTokenFromSearchParams } from "@/app/lib/ocrPageAuth";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OcrBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { batchId: raw } = await params;
  const batchId = decodeURIComponent(raw).trim();
  if (!UUID_RE.test(batchId)) notFound();

  loadVfmEnv();
  const sp = await searchParams;
  const token = readOcrTokenFromSearchParams(sp);
  if (!isOcrPageAuthorized(token)) {
    return (
      <main className="page">
        <div className="banner danger">
          Access denied. Provide a valid <code>token</code> query parameter matching <code>VFM_UPLOAD_TOKEN</code>, or use
          Bearer auth from an API client.
        </div>
      </main>
    );
  }

  const pool = createPool();
  let meta: Awaited<ReturnType<typeof getOcrBatchMeta>> | null = null;
  let summary: Awaited<ReturnType<typeof getOcrBatchSummary>> | null = null;
  let progress: Awaited<ReturnType<typeof getOcrReviewProgress>> | null = null;
  try {
    meta = await getOcrBatchMeta(pool, batchId);
    summary = await getOcrBatchSummary(pool, batchId);
    progress = await getOcrReviewProgress(pool, batchId);
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (!meta) notFound();

  const tokQ = token ? `?token=${encodeURIComponent(token)}` : "";

  return (
    <main className="page">
      <p style={{ margin: "0 0 1rem" }}>
        <Link href="/">Home</Link> · <Link href="/reports">Reports</Link>
      </p>
      <div className="page-hero">
        <h1>OCR image batch</h1>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          Operator-only summary. Raw signer fields are not shown on public reports—use the review UI for row-level PII.
        </p>
      </div>

      <div className="card">
        <h2>Batch</h2>
        <p>
          <strong>ID</strong> <code>{meta.id}</code>
        </p>
        <p>
          <strong>Petition</strong> {meta.petition_code} · <strong>File</strong> {meta.original_file_name}
        </p>
        <p>
          <strong>Status</strong> {meta.status} · <strong>Human review</strong> {meta.human_review_status} ·{" "}
          <strong>Project</strong> {meta.project_key}
        </p>
        <p style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
          <strong>Created</strong> {meta.created_at}
        </p>
      </div>

      <div className="card">
        <h2>Rollups</h2>
        {summary ? (
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            <li>Extracted rows: {summary.total_extracted_rows}</li>
            <li>Confirmed: {summary.confirmed_rows}</li>
            <li>Edited: {summary.edited_rows}</li>
            <li>Rejected: {summary.rejected_rows}</li>
            <li>Avg OCR confidence: {summary.avg_extraction_confidence_pct ?? "—"}</li>
          </ul>
        ) : (
          <p className="muted-p">Summary view unavailable (apply migration 008).</p>
        )}
        {progress && (
          <p style={{ marginTop: "0.75rem", fontSize: "0.9rem" }}>
            Needs review (row statuses): <strong>{progress.needs_review}</strong> · Confirmed:{" "}
            <strong>{progress.confirmed}</strong> · Edited: <strong>{progress.edited}</strong> · Rejected:{" "}
            <strong>{progress.rejected}</strong>
          </p>
        )}
        <p style={{ marginTop: "1rem" }}>
          <Link href={`/ocr/${encodeURIComponent(batchId)}/review${tokQ}`}>Open review workspace →</Link>
        </p>
      </div>
    </main>
  );
}
