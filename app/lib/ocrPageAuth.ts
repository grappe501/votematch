/** Operator OCR pages: same secret as upload token, via query param (browser navigation) or future cookie. */
export function readOcrTokenFromSearchParams(searchParams: Record<string, string | string[] | undefined>): string | null {
  const raw = searchParams.token;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

export function isOcrPageAuthorized(tokenFromQuery: string | null): boolean {
  const expected = process.env.VFM_UPLOAD_TOKEN?.trim();
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }
  return tokenFromQuery === expected;
}
