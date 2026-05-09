import { NextResponse } from "next/server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { bulkConfirmOcrRowsForImport } from "@/tools/voter-file-matcher/src/ocrPipeline";
import { checkUploadToken } from "@/tools/voter-file-matcher/src/uploadAuth";

export const runtime = "nodejs";

type Body = {
  row_ids?: string[];
  corrected_by?: string | null;
};

export async function POST(request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  loadVfmEnv();
  if (!checkUploadToken(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { batchId } = await ctx.params;
  const b = decodeURIComponent(batchId).trim();

  let body: Body = {};
  try {
    const t = await request.text();
    if (t.trim()) body = JSON.parse(t) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rowIds = Array.isArray(body.row_ids) ? body.row_ids.map(String) : null;
  const correctedBy = body.corrected_by != null ? String(body.corrected_by) : null;

  const pool = createPool();
  try {
    const n = await bulkConfirmOcrRowsForImport(pool, b, rowIds, correctedBy);
    return NextResponse.json({ ok: true, rows_confirmed: n });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
