"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { withReviewToken } from "@/lib/reviewOperatorToken";
import type { ReviewCandidateUi } from "@/tools/voter-file-matcher/src/webReview";

function authHeaders(token: string | null): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function ReviewActionButtons({
  batchId,
  rowNumber,
  token,
  candidates,
  queueUrl,
  selectedRank,
  setSelectedRank,
}: {
  batchId: string;
  rowNumber: number;
  token: string | null;
  candidates: ReviewCandidateUi[];
  queueUrl: string;
  selectedRank: number | null;
  setSelectedRank: (n: number | null) => void;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const goNextOrQueue = useCallback(async () => {
    try {
      const res = await fetch(`/api/review/${batchId}/next`, { headers: authHeaders(token) });
      const j = (await res.json().catch(() => ({}))) as { row_number?: number | null };
      if (res.ok && j.row_number != null && Number.isFinite(j.row_number)) {
        router.push(withReviewToken(`/review/${batchId}/row/${j.row_number}`, token));
      } else {
        router.push(queueUrl);
      }
    } catch {
      router.push(queueUrl);
    }
  }, [batchId, queueUrl, router, token]);

  const postJson = useCallback(
    async (path: string, body: unknown) => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(token) },
          body: JSON.stringify(body),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean; summary?: { blocked?: string } };
        if (!res.ok) {
          setMessage(j.error ?? `Request failed (${res.status})`);
          return null;
        }
        return j;
      } catch {
        setMessage("Network error.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [token]
  );

  const onSelectVoter = async () => {
    if (!selectedRank) {
      setMessage("Choose a candidate first.");
      return;
    }
    const pick = candidates.find((c) => c.candidate_rank === selectedRank);
    const ooj = (pick?.jurisdiction_status ?? "").toUpperCase() === "OUT_OF_JURISDICTION";
    const allow = ooj ? window.confirm("This voter is flagged out of jurisdiction. Attach anyway?") : true;
    if (!allow) return;
    const j = await postJson(`/api/review/${batchId}/row/${rowNumber}/select`, {
      candidateNumber: selectedRank,
      note: note.trim() || "Selected from web review",
      allowOutOfJurisdictionAttach: ooj && allow,
    });
    if (j?.summary && typeof j.summary === "object" && "blocked" in j.summary && j.summary.blocked === "OUT_OF_JURISDICTION") {
      setMessage("Out-of-jurisdiction attach blocked. Use override confirm or choose another voter.");
      return;
    }
    if (j?.ok) await goNextOrQueue();
  };

  const onMore = async () => {
    const j = await postJson(`/api/review/${batchId}/row/${rowNumber}/more`, {});
    if (j?.ok) router.refresh();
  };

  const onNonvoter = async () => {
    if (note.trim().length < 2) {
      setMessage("Add a note (reason) for nonvoter placement.");
      return;
    }
    const j = await postJson(`/api/review/${batchId}/row/${rowNumber}/nonvoter`, { note: note.trim() });
    if (j?.ok) await goNextOrQueue();
  };

  const onNeedsInfo = async () => {
    if (note.trim().length < 2) {
      setMessage("Add a note for needs more info.");
      return;
    }
    const j = await postJson(`/api/review/${batchId}/row/${rowNumber}/needs-more-info`, { note: note.trim() });
    if (j?.ok) await goNextOrQueue();
  };

  const onReject = async () => {
    if (note.trim().length < 2) {
      setMessage("Add a note to reject.");
      return;
    }
    const j = await postJson(`/api/review/${batchId}/row/${rowNumber}/reject`, { note: note.trim() });
    if (j?.ok) await goNextOrQueue();
  };

  return (
    <div className="review-actions">
      <label className="field-label">
        Note (required for nonvoter / needs info / reject)
        <textarea className="field-textarea" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
      </label>
      {message && <div className="banner danger">{message}</div>}
      <div className="button-row">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void onSelectVoter()}>
          Select this voter
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void onMore()}>
          Show 5 more
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void onNonvoter()}>
          Place in nonvoter file
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void onNeedsInfo()}>
          Needs more info
        </button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void onReject()}>
          Reject row
        </button>
      </div>
      <div className="button-row" style={{ marginTop: "0.75rem" }}>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => router.push(queueUrl)}>
          Back to queue
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void goNextOrQueue()}>
          Next review row
        </button>
      </div>
    </div>
  );
}
