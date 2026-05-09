type Dist = {
  pct_100: number;
  pct_90_99: number;
  pct_80_89: number;
  pct_50_79: number;
  pct_1_49: number;
  pct_0: number;
};

const ROWS: { key: keyof Dist; label: string }[] = [
  { key: "pct_100", label: "100%" },
  { key: "pct_90_99", label: "90–99%" },
  { key: "pct_80_89", label: "80–89%" },
  { key: "pct_50_79", label: "50–79%" },
  { key: "pct_1_49", label: "1–49%" },
  { key: "pct_0", label: "0%" },
];

export function ConfidenceBar(props: { distribution: Dist }) {
  const d = props.distribution;
  const total = ROWS.reduce((acc, r) => acc + (d[r.key] ?? 0), 0);
  if (total === 0) {
    return <p className="muted-p">No confidence data (run imports after migration 006, or no scored rows yet).</p>;
  }
  const max = Math.max(...ROWS.map((r) => d[r.key]), 1);
  return (
    <div className="confidence-bars">
      {ROWS.map((r) => {
        const n = d[r.key];
        const w = Math.round((n / max) * 100);
        return (
          <div key={r.key} className="confidence-row">
            <div className="confidence-label">{r.label}</div>
            <div className="confidence-track" aria-label={`${r.label}: ${n}`}>
              <div className="confidence-fill" style={{ width: `${w}%` }} />
            </div>
            <div className="confidence-n">{n}</div>
          </div>
        );
      })}
    </div>
  );
}
