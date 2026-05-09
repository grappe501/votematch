type Progress = {
  total_rows: number;
  slam_dunk_matched: number;
  needs_review_total: number;
  unresolved_review_rows: number;
  manually_approved: number;
  rejected: number;
  needs_more_info: number;
  percent_complete: number;
};

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

export function ReviewProgressPanel({ progress }: { progress: Progress | null }) {
  if (!progress) {
    return (
      <div className="banner">
        Review progress is unavailable until reporting views exist (migration 005+).
      </div>
    );
  }
  return (
    <div className="card review-progress-panel">
      <h2 style={{ marginTop: 0 }}>Review progress</h2>
      <div className="metric-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))" }}>
        <div>
          <div className="metric-label">Total rows</div>
          <div className="metric-value">{fmt(progress.total_rows)}</div>
        </div>
        <div>
          <div className="metric-label">Unresolved queue</div>
          <div className="metric-value">{fmt(progress.unresolved_review_rows)}</div>
        </div>
        <div>
          <div className="metric-label">Complete</div>
          <div className="metric-value">{progress.percent_complete.toFixed(1)}%</div>
        </div>
        <div>
          <div className="metric-label">Manual approvals</div>
          <div className="metric-value">{fmt(progress.manually_approved)}</div>
        </div>
        <div>
          <div className="metric-label">Rejected</div>
          <div className="metric-value">{fmt(progress.rejected)}</div>
        </div>
        <div>
          <div className="metric-label">Needs more info</div>
          <div className="metric-value">{fmt(progress.needs_more_info)}</div>
        </div>
      </div>
    </div>
  );
}
