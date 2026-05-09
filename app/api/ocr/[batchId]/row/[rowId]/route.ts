import { NextResponse } from "next/server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import {
  confirmOcrRow,
  rejectOcrRow,
  updateOcrRowCorrection,
  type OcrRowUpdateFields,
} from "@/tools/voter-file-matcher/src/ocrReview";
import { checkUploadToken } from "@/tools/voter-file-matcher/src/uploadAuth";

export const runtime = "nodejs";

type Body = {
  corrected?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  human_review_status?: "EDITED" | "CONFIRMED" | "NEEDS_REVIEW" | "REJECTED" | "CANCELLED";
  action?: "confirm" | "reject";
  corrected_by?: string | null;
};

export async function PATCH(request: Request, ctx: { params: Promise<{ batchId: string; rowId: string }> }) {
  loadVfmEnv();
  if (!checkUploadToken(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { batchId, rowId } = await ctx.params;
  const b = decodeURIComponent(batchId).trim();
  const r = decodeURIComponent(rowId).trim();

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const correctedBy = body.corrected_by != null ? String(body.corrected_by) : null;
  const pool = createPool();
  try {
    if (body.action === "reject") {
      const ok = await rejectOcrRow(pool, b, r, correctedBy);
      if (!ok) return NextResponse.json({ error: "Row not found." }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "confirm") {
      const ok = await confirmOcrRow(pool, b, r, correctedBy);
      if (!ok) return NextResponse.json({ error: "Row not found or not confirmable." }, { status: 404 });
      return NextResponse.json({ ok: true });
    }

    const fields = (body.fields ?? body.corrected) as Record<string, unknown> | undefined;
    if (!fields || typeof fields !== "object") {
      return NextResponse.json({ error: "Expected fields or corrected object." }, { status: 400 });
    }
    const st = body.human_review_status ?? "EDITED";
    if (st !== "EDITED" && st !== "CONFIRMED" && st !== "NEEDS_REVIEW") {
      return NextResponse.json({ error: "Invalid human_review_status for PATCH." }, { status: 400 });
    }
    const status = st;

    const ok = await updateOcrRowCorrection(pool, {
      batchId: b,
      rowId: r,
      fields: fields as OcrRowUpdateFields,
      correctedBy,
      human_review_status: status,
    });
    if (!ok) return NextResponse.json({ error: "Row not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
