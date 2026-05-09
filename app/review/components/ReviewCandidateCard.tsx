"use client";

import type { ReviewCandidateUi } from "@/tools/voter-file-matcher/src/webReview";

export function ReviewCandidateCard({
  c,
  selectedRank,
  onSelectRank,
}: {
  c: ReviewCandidateUi;
  selectedRank: number | null;
  onSelectRank: (rank: number) => void;
}) {
  const ooj = (c.jurisdiction_status ?? "").toUpperCase() === "OUT_OF_JURISDICTION";
  return (
    <div className={`candidate-card${ooj ? " candidate-card-ooj" : ""}`}>
      <label className="candidate-select">
        <input
          type="radio"
          name="candidate_pick"
          checked={selectedRank === c.candidate_rank}
          onChange={() => onSelectRank(c.candidate_rank)}
        />
        <span className="candidate-rank">#{c.candidate_rank}</span>
        <span className="candidate-score">{Math.round(c.candidate_score)}%</span>
      </label>
      <div className="candidate-body">
        <div>
          <strong>{c.first_name ?? ""} {c.last_name ?? ""}</strong>
          <span className="muted-p" style={{ marginLeft: "0.35rem" }}>
            {c.voter_id}
          </span>
        </div>
        <div className="muted-p" style={{ fontSize: "0.85rem" }}>
          {[c.address, [c.city, c.state, c.zip5].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
        </div>
        <div className="muted-p" style={{ fontSize: "0.8rem" }}>
          Ward {c.ward ?? "—"} · Precinct {c.precinct ?? "—"}
          {c.birth_year != null || c.birth_date ? (
            <>
              {" "}
              · DOB {c.birth_date ?? (c.birth_year != null ? String(c.birth_year) : "—")}
            </>
          ) : null}
        </div>
        <div className="candidate-reason">{c.candidate_reason ?? ""}</div>
        {ooj && <div className="banner danger" style={{ marginTop: "0.5rem", padding: "0.35rem 0.5rem" }}>Out of jurisdiction</div>}
      </div>
    </div>
  );
}
