export function MetricCard(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-card-value">{props.value}</div>
      <div className="metric-card-label">{props.label}</div>
      {props.hint ? <div className="metric-card-hint">{props.hint}</div> : null}
    </div>
  );
}
