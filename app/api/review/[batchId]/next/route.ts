import { NextResponse } from "next/server";
import { requireOperatorToken } from "@/lib/operatorAuth.server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import { resolveReviewCanonicalContext, webRunReviewNext } from "@/tools/voter-file-matcher/src/webReview";

export const runtime = "nodejs";

function mapCandidates(c: { candidate_rank: number; voter_id: string; candidate_score: number; candidate_reason: string | null; jurisdiction_status: string | null }) {
  return {
    candidate_rank: c.candidate_rank,
    voter_id: c.voter_id,
    candidate_score: c.candidate_score,
    candidate_reason: c.candidate_reason,
    jurisdiction_status: c.jurisdiction_status,
  };
}

export async function GET(request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const denied = requireOperatorToken(request);
  if (denied) return denied;
  const { batchId } = await ctx.params;
  if (!isValidUuid(batchId)) {
    return NextResponse.json({ error: "Invalid batch id." }, { status: 400 });
  }
  loadVfmEnv();
  const canon = await resolveReviewCanonicalContext();
  if (!canon.ok) {
    return NextResponse.json({ error: canon.error }, { status: 503 });
  }
  const pool = createPool();
  try {
    const r = await webRunReviewNext(pool, batchId, canon);
    const rn = r.queue_row?.row_number ?? null;
    return NextResponse.json({
      has_row: rn != null,
      row_number: rn,
      candidates: r.candidates.map(mapCandidates),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Review next failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
