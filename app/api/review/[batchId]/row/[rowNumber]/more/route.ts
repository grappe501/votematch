import { NextResponse } from "next/server";
import { requireOperatorToken } from "@/lib/operatorAuth.server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import { resolveReviewCanonicalContext, webRunMoreReviewCandidates } from "@/tools/voter-file-matcher/src/webReview";

export const runtime = "nodejs";

export async function POST(request: Request, ctx: { params: Promise<{ batchId: string; rowNumber: string }> }) {
  const denied = requireOperatorToken(request);
  if (denied) return denied;
  const { batchId, rowNumber: rowRaw } = await ctx.params;
  if (!isValidUuid(batchId)) {
    return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
  }
  const rowNumber = Number.parseInt(rowRaw, 10);
  if (!Number.isFinite(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number." }, { status: 400 });
  }
  loadVfmEnv();
  const canon = await resolveReviewCanonicalContext();
  if (!canon.ok) {
    return NextResponse.json({ error: canon.error }, { status: 503 });
  }
  const pool = createPool();
  try {
    const r = await webRunMoreReviewCandidates(pool, { batchId, rowNumber }, canon);
    return NextResponse.json({
      ok: true,
      candidate_page: r.candidate_page,
      candidate_search_offset: r.candidate_search_offset,
      candidates: r.candidates.map((c) => ({
        candidate_rank: c.candidate_rank,
        voter_id: c.voter_id,
        candidate_score: c.candidate_score,
        candidate_reason: c.candidate_reason,
        jurisdiction_status: c.jurisdiction_status,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "More candidates failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
