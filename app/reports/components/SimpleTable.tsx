import type { ReactNode } from "react";

export function SimpleTable(props: {
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: Record<string, ReactNode>[];
  empty?: ReactNode;
}) {
  if (props.rows.length === 0) {
    return <p className="muted-p">{props.empty ?? "No rows."}</p>;
  }
  return (
    <div className="table-wrap">
      <table className="grid report-table">
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} className={c.align === "right" ? "num" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => (
            <tr key={i}>
              {props.columns.map((c) => (
                <td key={c.key} className={c.align === "right" ? "num" : undefined}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
