import { NextResponse } from "next/server";
import { requireOperatorToken } from "@/lib/operatorAuth.server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import { safeRunReviewProgress } from "@/tools/voter-file-matcher/src/webReview";

export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const denied = requireOperatorToken(request);
  if (denied) return denied;
  const { batchId } = await ctx.params;
  if (!isValidUuid(batchId)) {
    return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
  }
  loadVfmEnv();
  const pool = createPool();
  try {
    const p = await safeRunReviewProgress(pool, batchId);
    if (!p) {
      return NextResponse.json({
        ok: false,
        warning: "Review progress unavailable (apply migrations 005+ or ensure batch_signature_report_rows exists).",
        progress: null,
      });
    }
    return NextResponse.json({ ok: true, progress: p });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
