import { NextResponse } from "next/server";
import { requireOperatorToken } from "@/lib/operatorAuth.server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import { resolveReviewCanonicalContext, webRunSelectReviewCandidate } from "@/tools/voter-file-matcher/src/webReview";

export const runtime = "nodejs";

type Body = {
  candidateNumber?: number;
  note?: string;
  allowOutOfJurisdictionAttach?: boolean;
};

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
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Expected JSON body." }, { status: 400 });
  }
  const candidateNumber = Number(body.candidateNumber);
  if (!Number.isFinite(candidateNumber) || candidateNumber < 1 || candidateNumber > 5) {
    return NextResponse.json({ error: "candidateNumber must be 1–5 for the current candidate page." }, { status: 400 });
  }
  const note = (body.note ?? "").trim() || "Selected from web review";
  loadVfmEnv();
  const canon = await resolveReviewCanonicalContext();
  if (!canon.ok) {
    return NextResponse.json({ error: canon.error }, { status: 503 });
  }
  const pool = createPool();
  try {
    const result = await webRunSelectReviewCandidate(
      pool,
      {
        batchId,
        rowNumber,
        candidateNumber,
        note,
        allowOutOfJurisdictionAttach: body.allowOutOfJurisdictionAttach === true,
      },
      canon
    );
    return NextResponse.json({ ok: true, summary: result.summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Select failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
