import { basename } from "node:path";
import { NextResponse } from "next/server";
import { createPool } from "../../../tools/voter-file-matcher/src/db";
import { loadVfmEnv } from "../../../tools/voter-file-matcher/src/env-load";
import { getOcrBatchMeta, ingestImageAndRunOcr } from "../../../tools/voter-file-matcher/src/ocrPipeline";
import { getOcrMaxBytes, validateOcrImageMime } from "../../../tools/voter-file-matcher/src/ocrStorage";
import { checkUploadToken, readBearerToken } from "../../../tools/voter-file-matcher/src/uploadAuth";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 45 * 1024 * 1024;

export async function POST(request: Request) {
  loadVfmEnv();

  const token = process.env.VFM_UPLOAD_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && !token) {
    return NextResponse.json(
      { error: "Server misconfiguration: set VFM_UPLOAD_TOKEN for production uploads." },
      { status: 503 }
    );
  }
  if (token && !checkUploadToken(request)) {
    return NextResponse.json({ error: "Unauthorized (missing or invalid upload token)." }, { status: 401 });
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured (required for image OCR)." }, { status: 503 });
  }
  if (!process.env.OPENAI_OCR_MODEL?.trim()) {
    return NextResponse.json({ error: "OPENAI_OCR_MODEL is not configured (required for image OCR)." }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Expected file field." }, { status: 400 });
  }
  const maxOcr = Math.min(MAX_BYTES, getOcrMaxBytes());
  if (file.size <= 0 || file.size > maxOcr) {
    return NextResponse.json({ error: `File empty or too large (max ${Math.round(maxOcr / (1024 * 1024))} MB for OCR).` }, { status: 400 });
  }

  const mimeRaw = (file.type || "application/octet-stream").toLowerCase();
  const mime = validateOcrImageMime(mimeRaw);
  if (!mime) {
    if (mimeRaw.includes("heic") || mimeRaw.includes("heif")) {
      return NextResponse.json({ error: "HEIC/HEIF is not supported. Convert to JPEG or PNG." }, { status: 415 });
    }
    if (mimeRaw === "application/pdf" || mimeRaw.includes("pdf")) {
      return NextResponse.json({ error: "PDF is not supported for OCR in this version. Use JPEG or PNG." }, { status: 415 });
    }
    return NextResponse.json({ error: "Only image/jpeg and image/png are supported for OCR intake." }, { status: 415 });
  }

  const petitionCode = String(form.get("petition_code") ?? form.get("petitionCode") ?? "").trim();
  if (!petitionCode) {
    return NextResponse.json({ error: "petition_code is required." }, { status: 400 });
  }

  const projectKey = String(form.get("project_key") ?? form.get("projectKey") ?? "sos").trim() || "sos";
  const sourceLabelRaw = String(form.get("source_label") ?? form.get("sourceLabel") ?? "").trim();
  const sourceLabel = sourceLabelRaw.length > 0 ? sourceLabelRaw : null;
  const createdBy = String(form.get("created_by") ?? form.get("createdBy") ?? "").trim() || null;

  const origName = basename(file.name || "upload").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const buf = Buffer.from(await file.arrayBuffer());

  const pool = createPool();
  try {
    const { batchId, extracted_row_count } = await ingestImageAndRunOcr({
      pool,
      buffer: buf,
      mimeType: mime,
      originalFileName: origName,
      projectKey,
      petitionCode,
      sourceLabel,
      createdBy,
    });

    const meta = await getOcrBatchMeta(pool, batchId);

    const base = new URL(request.url);
    const reviewPath = `/ocr/${encodeURIComponent(batchId)}/review`;
    const bearer = readBearerToken(request);
    const reviewUrl = bearer
      ? `${base.origin}${reviewPath}?token=${encodeURIComponent(bearer)}`
      : `${base.origin}${reviewPath}`;

    return NextResponse.json({
      ocr_batch_id: batchId,
      status: meta?.status ?? "UNKNOWN",
      extracted_row_count,
      review_url: reviewUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "OCR intake failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    await pool.end().catch(() => undefined);
  }
}
