import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { checkOperatorReviewToken } from "../tools/voter-file-matcher/src/uploadAuth";
import { getTokenFromSearchParams } from "./reviewOperatorToken";

export async function getTokenFromCookies(): Promise<string | null> {
  const jar = await cookies();
  return jar.get("votematch_operator_token")?.value?.trim() || null;
}

/**
 * Server components: allow when no VFM_UPLOAD_TOKEN in non-production; otherwise require ?token= or cookie match.
 */
export async function serverReviewAccessAllowed(
  searchParams: Record<string, string | string[] | undefined>
): Promise<boolean> {
  const expected = process.env.VFM_UPLOAD_TOKEN?.trim();
  if (!expected) {
    return process.env.NODE_ENV !== "production";
  }
  const q = getTokenFromSearchParams(searchParams);
  const ck = await getTokenFromCookies();
  return Boolean((q && q === expected) || (ck && ck === expected));
}

export function requireOperatorToken(request: Request): NextResponse | null {
  if (!checkOperatorReviewToken(request)) {
    return NextResponse.json({ error: "Operator access required." }, { status: 401 });
  }
  return null;
}
