import Link from "next/link";
import { notFound } from "next/navigation";
import { OcrReviewClient, type OcrReviewRow } from "@/components/OcrReviewClient";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { getOcrBatchMeta, getOcrRowsForReview } from "@/tools/voter-file-matcher/src/ocrPipeline";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isOcrPageAuthorized, readOcrTokenFromSearchParams } from "@/app/lib/ocrPageAuth";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OcrReviewPage({
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
  if (!token || !isOcrPageAuthorized(token)) {
    return (
      <main className="page">
        <div className="banner danger">
          Access denied. Append <code>?token=…</code> (same value as <code>VFM_UPLOAD_TOKEN</code>) to this URL.
        </div>
      </main>
    );
  }

  const pool = createPool();
  let meta: Awaited<ReturnType<typeof getOcrBatchMeta>> | null = null;
  let rows: unknown[] = [];
  try {
    meta = await getOcrBatchMeta(pool, batchId);
    rows = await getOcrRowsForReview(pool, batchId);
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (!meta) notFound();

  const plainRows = JSON.parse(JSON.stringify(rows)) as OcrReviewRow[];

  return (
    <main className="page">
      <p style={{ margin: "0 0 1rem" }}>
        <Link href={`/ocr/${encodeURIComponent(batchId)}?token=${encodeURIComponent(token)}`}>← Batch summary</Link>
      </p>
      <div className="page-hero">
        <h1>OCR review — {meta.petition_code}</h1>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          Edit extracted fields, then confirm rows. Import runs the normal matcher pipeline only after confirmation.
        </p>
      </div>
      <div className="banner">
        This page may display signer-like fields from the petition image. Treat as sensitive. Do not share URLs with
        embedded tokens.
      </div>
      <OcrReviewClient batchId={batchId} token={token} initialRows={plainRows} />
    </main>
  );
}
