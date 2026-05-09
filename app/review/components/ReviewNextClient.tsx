"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { withReviewToken } from "@/lib/reviewOperatorToken";

function authHeaders(token: string | null): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function ReviewNextClient({ batchId, token }: { batchId: string; token: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div>
      {msg && <div className="banner danger" style={{ marginBottom: "0.75rem" }}>{msg}</div>}
      <button
        type="button"
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const res = await fetch(`/api/review/${batchId}/next`, { headers: authHeaders(token) });
            const j = (await res.json()) as { row_number?: number | null; error?: string };
            if (!res.ok) {
              setMsg(j.error ?? "Could not load next row.");
              return;
            }
            if (j.row_number != null && Number.isFinite(j.row_number)) {
              router.push(withReviewToken(`/review/${batchId}/row/${j.row_number}`, token));
            } else {
              setMsg("No more rows in the review queue for this batch.");
            }
          } catch {
            setMsg("Network error.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Review next row
      </button>
    </div>
  );
}
