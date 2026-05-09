import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const ALLOWED = new Set(["image/jpeg", "image/jpg", "image/png"]);

export function computeSha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function getOcrMaxBytes(): number {
  const mb = Number.parseInt(process.env.VFM_OCR_MAX_FILE_MB ?? "10", 10);
  const n = Number.isFinite(mb) && mb > 0 ? mb : 10;
  return n * 1024 * 1024;
}

export function validateOcrImageMime(mime: string): "image/jpeg" | "image/png" | null {
  const m = mime.toLowerCase().trim();
  if (m === "image/jpg" || m === "image/jpeg") return "image/jpeg";
  if (m === "image/png") return "image/png";
  return null;
}

export async function ensureOcrIncomingDir(): Promise<string> {
  const dir = resolve(process.cwd(), "tools/voter-file-matcher/ocr-incoming");
  await mkdir(dir, { recursive: true });
  return dir;
}

export type SavedOcrFile = {
  stored_file_path: string;
  file_hash: string;
  file_size: number;
  mime_type: "image/jpeg" | "image/png";
};

/**
 * Writes upload to disk under ocr-incoming/{batchId}/ using a unique name. Does not overwrite.
 */
export async function saveOcrUploadFile(params: {
  batchId: string;
  originalFileName: string;
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png";
}): Promise<SavedOcrFile> {
  const max = getOcrMaxBytes();
  if (params.buffer.length > max) {
    throw new Error(`Image exceeds VFM_OCR_MAX_FILE_MB limit (${Math.round(max / (1024 * 1024))} MB).`);
  }
  if (params.buffer.length <= 0) {
    throw new Error("Empty image file.");
  }

  const baseDir = await ensureOcrIncomingDir();
  const batchDir = join(baseDir, params.batchId);
  await mkdir(batchDir, { recursive: true });

  const hash = computeSha256Hex(params.buffer);
  const safeName = basename(params.originalFileName || "upload").replace(/[^a-zA-Z0-9._-]+/g, "_");
  const ext = params.mimeType === "image/png" ? ".png" : ".jpg";
  const fileName = `${hash.slice(0, 16)}_${safeName}${ext}`;
  const finalPath = join(batchDir, fileName);

  const tmpPath = `${finalPath}.tmp-${Date.now()}`;
  await writeFile(tmpPath, params.buffer);
  try {
    await rename(tmpPath, finalPath);
  } catch {
    throw new Error("Could not finalize OCR file write (path collision or permissions).");
  }

  return {
    stored_file_path: finalPath,
    file_hash: hash,
    file_size: params.buffer.length,
    mime_type: params.mimeType,
  };
}
