import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export async function computeFileSha256(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

export async function getFileSizeBytes(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return Number(s.size);
}

export function shortHash(hash: string, length = 12): string {
  if (length <= 0) return "";
  return hash.slice(0, Math.min(length, hash.length));
}
