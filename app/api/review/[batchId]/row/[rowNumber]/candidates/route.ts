import { NextResponse } from "next/server";
import { requireOperatorToken } from "@/lib/operatorAuth.server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import {
  ensureReviewCandidateSnapshotsForRow,
  fetchCandidatesForRowPageUi,
  resolveReviewCanonicalContext,
} from "@/tools/voter-file-matcher/src/webReview";

export const runtime = "nodejs";

export async function GET(request: Request, ctx: { params: Promise<{ batchId: string; rowNumber: string }> }) {
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
    const ensured = await ensureReviewCandidateSnapshotsForRow(pool, batchId, rowNumber, canon);
    if (!ensured.ok) {
      return NextResponse.json({ error: ensured.error }, { status: 400 });
    }
    const candidates = await fetchCandidatesForRowPageUi(pool, batchId, rowNumber);
    return NextResponse.json({ ok: true, candidates });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Candidates failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
