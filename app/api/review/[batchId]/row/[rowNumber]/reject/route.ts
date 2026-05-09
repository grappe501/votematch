import { NextResponse } from "next/server";
import { requireOperatorToken } from "@/lib/operatorAuth.server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { isValidUuid } from "@/tools/voter-file-matcher/src/webReports";
import { webRunReject } from "@/tools/voter-file-matcher/src/webReview";

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
  let note = "";
  try {
    const body = (await request.json()) as { note?: string };
    note = (body.note ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Expected JSON body with note." }, { status: 400 });
  }
  if (note.length < 2) {
    return NextResponse.json({ error: "A note is required to reject." }, { status: 400 });
  }
  loadVfmEnv();
  const pool = createPool();
  try {
    const result = await webRunReject(pool, { batchId, rowNumber, note });
    return NextResponse.json({ ok: true, summary: result.summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Reject failed.";
    return NextResponse.json({ error: msg }, { status: 400 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
