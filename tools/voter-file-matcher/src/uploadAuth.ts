/**
 * Shared Bearer / upload token checks for ingest and OCR operator routes.
 * Never log token values.
 */

export function readBearerToken(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return null;
  const t = h.slice("Bearer ".length).trim();
  return t.length > 0 ? t : null;
}

export function uploadTokenExpected(): boolean {
  return Boolean(process.env.VFM_UPLOAD_TOKEN?.trim()) || process.env.NODE_ENV === "production";
}

export function checkUploadToken(request: Request): boolean {
  const expected = process.env.VFM_UPLOAD_TOKEN?.trim();
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }
  const got = readBearerToken(request);
  return got === expected;
}

function readCookieNamed(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    const v = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

/**
 * Operator token for protected review UI and /api/review/* routes.
 * Same secret as upload: VFM_UPLOAD_TOKEN. Never log returned values.
 */
export function getOperatorTokenFromRequest(request: Request): string | null {
  const bearer = readBearerToken(request);
  if (bearer) return bearer;
  try {
    const u = new URL(request.url);
    const q = u.searchParams.get("token")?.trim();
    if (q) return q;
  } catch {
    /* ignore */
  }
  return readCookieNamed(request.headers.get("cookie"), "votematch_operator_token");
}

/** When unset in dev, allow access; in production VFM_UPLOAD_TOKEN is required. */
export function operatorReviewTokenConfigured(): boolean {
  return Boolean(process.env.VFM_UPLOAD_TOKEN?.trim()) || process.env.NODE_ENV === "production";
}

export function checkOperatorReviewToken(request: Request): boolean {
  const expected = process.env.VFM_UPLOAD_TOKEN?.trim();
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }
  const got = getOperatorTokenFromRequest(request);
  return Boolean(got && got === expected);
}
