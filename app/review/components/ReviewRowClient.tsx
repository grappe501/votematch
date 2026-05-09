"use client";

import { useState } from "react";
import type { ReviewCandidateUi } from "@/tools/voter-file-matcher/src/webReview";
import { ReviewActionButtons } from "./ReviewActionButtons";
import { ReviewCandidateCard } from "./ReviewCandidateCard";

export function ReviewRowClient({
  batchId,
  rowNumber,
  token,
  candidates,
  queueUrl,
}: {
  batchId: string;
  rowNumber: number;
  token: string | null;
  candidates: ReviewCandidateUi[];
  queueUrl: string;
}) {
  const [selectedRank, setSelectedRank] = useState<number | null>(null);
  return (
    <>
      <div className="candidate-grid">
        {candidates.map((c) => (
          <ReviewCandidateCard key={c.candidate_rank} c={c} selectedRank={selectedRank} onSelectRank={setSelectedRank} />
        ))}
      </div>
      <ReviewActionButtons
        batchId={batchId}
        rowNumber={rowNumber}
        token={token}
        candidates={candidates}
        queueUrl={queueUrl}
        selectedRank={selectedRank}
        setSelectedRank={setSelectedRank}
      />
    </>
  );
}
