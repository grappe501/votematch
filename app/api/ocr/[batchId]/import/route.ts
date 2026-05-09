import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { createPool } from "@/tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "@/tools/voter-file-matcher/src/env-load";
import { confirmOcrRowsToImport } from "@/tools/voter-file-matcher/src/ocrPipeline";
import { checkUploadToken } from "@/tools/voter-file-matcher/src/uploadAuth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request, ctx: { params: Promise<{ batchId: string }> }) {
  loadVfmEnv();
  if (!checkUploadToken(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { batchId } = await ctx.params;
  const b = decodeURIComponent(batchId).trim();

  const mapRel =
    process.env.VFM_SOURCE_PROFILE_PATH?.trim() ||
    "tools/voter-file-matcher/configs/petition-mail-list-share-v1.json";
  const mapPath = resolve(process.cwd(), mapRel);
  const chunkSizeRaw = Number.parseInt(process.env.VFM_CHUNK_SIZE ?? "500", 10);
  const chunkSize = Number.isFinite(chunkSizeRaw) && chunkSizeRaw > 0 ? chunkSizeRaw : 500;

  let correctedBy: string | null = null;
  try {
    const t = await request.text();
    if (t.trim()) {
      const j = JSON.parse(t) as { corrected_by?: string | null };
      correctedBy = j.corrected_by != null ? String(j.corrected_by) : null;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const pool = createPool();
  try {
    const result = await confirmOcrRowsToImport({
      pool,
      batchId: b,
      mapPath,
      mapRel,
      createdBy: correctedBy ?? "ocr-import-api",
      chunkSize,
    });
    const base = new URL(request.url);
    return NextResponse.json({
      ok: true,
      import_batch_id: result.import_batch_id,
      rows_imported: result.rows_imported,
      report_path_hint: result.report_dir,
      reports_url: `${base.origin}/reports`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Import failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
