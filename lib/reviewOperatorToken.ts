/**
 * Client-safe token helpers for review navigation (no next/headers).
 */
import { operatorReviewTokenConfigured } from "../tools/voter-file-matcher/src/uploadAuth";

export function getTokenFromSearchParams(
  sp: Record<string, string | string[] | undefined> | null | undefined
): string | null {
  if (!sp) return null;
  const raw = sp.token;
  if (Array.isArray(raw)) return raw[0]?.trim() || null;
  return typeof raw === "string" ? raw.trim() || null : null;
}

export function reviewTokenQuerySuffix(token: string | null): string {
  if (!token) return "";
  return `?token=${encodeURIComponent(token)}`;
}

export function withReviewToken(path: string, token: string | null): string {
  if (!token) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}`;
}

export function operatorTokenRequiredMessage(): string {
  if (!operatorReviewTokenConfigured()) {
    return "Set VFM_UPLOAD_TOKEN in this environment to protect signer data in production.";
  }
  return "Paste your operator token in the URL as ?token=… or set the votematch_operator_token cookie.";
}
