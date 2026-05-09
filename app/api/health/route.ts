import { NextResponse } from "next/server";
import { loadVfmEnv } from "../../../tools/voter-file-matcher/src/env-load";

export const runtime = "nodejs";

export function GET() {
  loadVfmEnv();
  const token = process.env.VFM_UPLOAD_TOKEN?.trim();
  const nodeEnv = process.env.NODE_ENV ?? "unknown";
  const openaiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  const ocrModel = Boolean(process.env.OPENAI_OCR_MODEL?.trim());
  return NextResponse.json({
    ok: true,
    app_mode: "votematch-next",
    node_env: nodeEnv,
    ingest_requires_token: Boolean(token) || nodeEnv === "production",
    upload_token_configured: Boolean(token),
    /** Same token gates `/review` and `/api/review/*` in production. */
    operator_review_token_configured: Boolean(token),
    database_configured: Boolean(process.env.DATABASE_URL?.trim()),
    /** True when OPENAI_API_KEY is set. */
    openai_configured: openaiKey,
    /** True when OPENAI_OCR_MODEL is set (required for /api/ingest-image). */
    ocr_model_configured: ocrModel,
    /** Server-side OCR intake can run (both key + OCR model configured). */
    ocr_enabled: openaiKey && ocrModel,
    /** Legacy flag: same as openai_configured. */
    vision_conversion_available: openaiKey,
  });
}
