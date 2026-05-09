import { NextResponse } from "next/server";
import { loadVfmEnv } from "../../../tools/voter-file-matcher/src/env-load";

export const runtime = "nodejs";

export function GET() {
  loadVfmEnv();
  const token = process.env.VFM_UPLOAD_TOKEN?.trim();
  const nodeEnv = process.env.NODE_ENV ?? "unknown";
  return NextResponse.json({
    ok: true,
    app_mode: "votematch-next",
    node_env: nodeEnv,
    ingest_requires_token: Boolean(token) || nodeEnv === "production",
    upload_token_configured: Boolean(token),
    database_configured: Boolean(process.env.DATABASE_URL?.trim()),
    /** True when OPENAI_API_KEY is set; spreadsheet ingest does not require it. */
    vision_conversion_available: Boolean(process.env.OPENAI_API_KEY?.trim()),
  });
}
