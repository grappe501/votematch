import Link from "next/link";
import { withReviewToken } from "@/lib/reviewOperatorToken";
import type { ReviewQueueTableRowUi } from "@/tools/voter-file-matcher/src/webReview";

function badgeClass(status: string): string {
  const s = status.toUpperCase();
  if (s === "MATCHED") return "badge badge-green";
  if (s === "NOT_FOUND" || s === "ERROR") return "badge badge-red";
  if (s === "MULTIPLE_MATCHES" || s === "WEAK_MATCH") return "badge badge-amber";
  return "badge badge-gray";
}

export function ReviewQueueTable({
  batchId,
  rows,
  token,
}: {
  batchId: string;
  rows: ReviewQueueTableRowUi[];
  token: string | null;
}) {
  if (rows.length === 0) {
    return <p className="muted-p">No rows in the review queue for this batch.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Row</th>
            <th>Confidence</th>
            <th>Match</th>
            <th>Review</th>
            <th>Problems</th>
            <th>City</th>
            <th>ZIP</th>
            <th>Jurisdiction</th>
            <th>Duplicate</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.row_number}>
              <td>{r.row_number}</td>
              <td>{r.match_confidence_pct != null ? `${r.match_confidence_pct}%` : "—"}</td>
              <td>
                <span className={badgeClass(r.match_status)}>{r.match_status}</span>
              </td>
              <td>{r.review_status}</td>
              <td style={{ maxWidth: "14rem", fontSize: "0.8rem" }}>{r.problem_summary}</td>
              <td>{r.signer_city ?? "—"}</td>
              <td>{r.signer_zip ?? "—"}</td>
              <td>{r.jurisdiction_status ?? "—"}</td>
              <td>{r.duplicate_status ?? "—"}</td>
              <td>
                <Link className="link-button" href={withReviewToken(`/review/${batchId}/row/${r.row_number}`, token)}>
                  Review
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
