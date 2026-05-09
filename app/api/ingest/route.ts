import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { NextResponse } from "next/server";
import { loadVfmEnv } from "../../../tools/voter-file-matcher/src/env-load";
import { loadHeaderMapFile } from "../../../tools/voter-file-matcher/src/headerMap";
import { imageBufferToPetitionMailXlsx } from "../../../tools/voter-file-matcher/src/imageSheetExtract";
import { runFullImport } from "../../../tools/voter-file-matcher/src/importRunner";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 45 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
]);

function checkBearer(request: Request, token: string): boolean {
  const h = request.headers.get("authorization");
  return h === `Bearer ${token}`;
}

export async function POST(request: Request) {
  loadVfmEnv();

  const token = process.env.VFM_UPLOAD_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && !token) {
    return NextResponse.json(
      { error: "Server misconfiguration: set VFM_UPLOAD_TOKEN for production uploads." },
      { status: 503 }
    );
  }
  if (token && !checkBearer(request, token)) {
    return NextResponse.json({ error: "Unauthorized (missing or invalid upload token)." }, { status: 401 });
  }

  const mapRel =
    process.env.VFM_SOURCE_PROFILE_PATH?.trim() ||
    "tools/voter-file-matcher/configs/petition-mail-list-share-v1.json";
  const mapPath = resolve(process.cwd(), mapRel);
  let mapFile: Awaited<ReturnType<typeof loadHeaderMapFile>>;
  try {
    mapFile = await loadHeaderMapFile(mapPath);
  } catch {
    return NextResponse.json(
      { error: "Could not load profile map (set VFM_SOURCE_PROFILE_PATH or install default config)." },
      { status: 500 }
    );
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
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File empty or too large." }, { status: 400 });
  }

  const mime = (file.type || "application/octet-stream").toLowerCase();
  const isImage = mime.startsWith("image/");

  if (!isImage) {
    if (!ALLOWED_MIME.has(mime) && !mime.includes("sheet") && !mime.includes("excel") && mime !== "text/csv") {
      return NextResponse.json({ error: `Unsupported content type: ${mime}` }, { status: 415 });
    }
  } else if (!["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mime)) {
    return NextResponse.json(
      { error: `Unsupported image type: ${mime}. Use JPEG, PNG, or WebP.` },
      { status: 415 }
    );
  }

  const petitionCode = String(form.get("petitionCode") ?? "").trim();
  const petitionName = String(form.get("petitionName") ?? "").trim();
  const projectKey = String(form.get("projectKey") ?? "").trim() || "sos";
  const sourceLabelRaw = String(form.get("sourceLabel") ?? "").trim();
  const autoCreateInitiative = form.get("autoCreateInitiative") === "true" || form.get("autoCreateInitiative") === "on";
  const initiativeScope = String(form.get("initiativeScope") ?? "").trim() || null;
  const reportingGeo = String(form.get("reportingGeo") ?? "").trim() || null;

  if (!petitionCode) {
    return NextResponse.json({ error: "petitionCode is required." }, { status: 400 });
  }
  if (!petitionName) {
    return NextResponse.json({ error: "petitionName is required." }, { status: 400 });
  }

  const origName = basename(file.name || "upload").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const buf = Buffer.from(await file.arrayBuffer());
  const sourceLabel =
    sourceLabelRaw.length > 0 ? sourceLabelRaw : isImage ? `photo:${origName}` : null;

  let tmpPath: string;
  if (isImage) {
    try {
      const xlsxBuf = await imageBufferToPetitionMailXlsx(buf.toString("base64"), mime);
      tmpPath = join(tmpdir(), `vfm-ingest-${randomUUID()}.xlsx`);
      await writeFile(tmpPath, xlsxBuf);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Image conversion failed";
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  } else {
    const ext = extname(origName).toLowerCase();
    if (![".csv", ".xlsx", ".xls"].includes(ext)) {
      return NextResponse.json({ error: "File must end with .csv, .xlsx, or .xls" }, { status: 400 });
    }
    tmpPath = join(tmpdir(), `vfm-ingest-${randomUUID()}${ext}`);
    await writeFile(tmpPath, buf);
  }

  const chunkSizeRaw = Number.parseInt(process.env.VFM_CHUNK_SIZE ?? "500", 10);
  const chunkSize = Number.isFinite(chunkSizeRaw) && chunkSizeRaw > 0 ? chunkSizeRaw : 500;

  try {
    const result = await runFullImport({
      filePath: tmpPath,
      mapPath,
      mapFile,
      petitionCode,
      petitionName,
      projectKey,
      sourceLabel,
      createdBy: "web-upload",
      chunkSize,
      autoCreateInitiative,
      initiativeScope: autoCreateInitiative ? initiativeScope : null,
      reportingGeo: autoCreateInitiative ? reportingGeo : null,
      targetSignatureCount: null,
      initiativeNotes: null,
      confirmMissingJurisdiction: false,
    });
    return NextResponse.json({
      ok: true,
      converted_from_image: isImage,
      result: {
        batch_id: result.batch_id,
        petition_code: result.petition_code,
        total_rows: result.total_rows,
        matched: result.matched,
        not_found: result.not_found,
        multiple_matches: result.multiple_matches,
        weak_matches: result.weak_matches,
        errors: result.errors,
        match_rate: result.match_rate,
        permanent_signatures_created_or_updated: result.permanent_signatures_created_or_updated,
        report_dir: result.report_dir,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Import failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}
