export function StatusBadge(props: { status: string }) {
  const s = props.status.toLowerCase();
  const tone =
    s.includes("complete") || s.includes("success") || s === "done"
      ? "ok"
      : s.includes("fail") || s.includes("error")
        ? "danger"
        : s.includes("pend") || s.includes("run") || s.includes("process")
          ? "warn"
          : "neutral";
  return <span className={`status-badge status-badge--${tone}`}>{props.status}</span>;
}
