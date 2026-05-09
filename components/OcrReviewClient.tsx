"use client";

import { useMemo, useState } from "react";

export type OcrReviewRow = {
  id: string;
  row_number: number;
  extraction_confidence_pct: number | null;
  human_review_status: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  birth_month: string | null;
  birth_day: string | null;
  birth_year: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  signed_at: string | null;
  notes: string | null;
  uncertain_fields: unknown;
  corrected_json?: Record<string, string> | null;
};

function displayField(r: OcrReviewRow, key: keyof OcrReviewRow): string {
  const cj = r.corrected_json;
  if (cj && typeof cj[key as string] === "string" && (cj[key as string] as string).length > 0) {
    return cj[key as string] as string;
  }
  const v = r[key];
  if (v == null) return "";
  return String(v);
}

export function OcrReviewClient(props: { batchId: string; token: string; initialRows: OcrReviewRow[] }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const authHeader = useMemo(() => ({ Authorization: `Bearer ${props.token}` }), [props.token]);

  async function patchRow(rowId: string, body: Record<string, unknown>) {
    setBusy(rowId);
    setMsg(null);
    try {
      const res = await fetch(`/api/ocr/${encodeURIComponent(props.batchId)}/row/${encodeURIComponent(rowId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) {
        setMsg(j.error ?? `Request failed (${res.status})`);
        return;
      }
      setMsg("Saved. Reload the page to refresh statuses.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function bulkConfirm() {
    setBusy("bulk");
    setMsg(null);
    try {
      const res = await fetch(`/api/ocr/${encodeURIComponent(props.batchId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });
      const j = (await res.json()) as { error?: string; rows_confirmed?: number };
      if (!res.ok) {
        setMsg(j.error ?? `Confirm failed (${res.status})`);
        return;
      }
      setMsg(`Confirmed ${j.rows_confirmed ?? 0} row(s). Reload to refresh.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    setBusy("import");
    setMsg(null);
    try {
      const res = await fetch(`/api/ocr/${encodeURIComponent(props.batchId)}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({}),
      });
      const j = (await res.json()) as { error?: string; import_batch_id?: string; reports_url?: string };
      if (!res.ok) {
        setMsg(j.error ?? `Import failed (${res.status})`);
        return;
      }
      setMsg(
        `Import complete. import_batch_id=${j.import_batch_id ?? ""} — open ${j.reports_url ?? "/reports"} for aggregate metrics.`
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
        <button className="primary" type="button" disabled={busy !== null} onClick={() => void bulkConfirm()}>
          {busy === "bulk" ? "Working…" : "Confirm all NEEDS_REVIEW / EDITED rows"}
        </button>
        <button className="primary" type="button" disabled={busy !== null} onClick={() => void runImport()}>
          {busy === "import" ? "Importing…" : "Import confirmed rows into matcher"}
        </button>
      </div>
      {msg && <p style={{ color: "var(--fg)", marginBottom: "1rem" }}>{msg}</p>}
      <div className="table-wrap">
        <table className="grid report-table" style={{ fontSize: "0.78rem" }}>
          <thead>
            <tr>
              <th>#</th>
              <th>OCR %</th>
              <th>Status</th>
              <th>First</th>
              <th>Last</th>
              <th>Full</th>
              <th>Mo/Da/Yr</th>
              <th>Address</th>
              <th>City</th>
              <th>ST</th>
              <th>ZIP</th>
              <th>Signed</th>
              <th>Notes</th>
              <th>Uncertain</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.initialRows.map((r) => {
              const unc = Array.isArray(r.uncertain_fields) ? (r.uncertain_fields as string[]).join(", ") : "";
              return (
                <tr key={r.id}>
                  <td>{r.row_number}</td>
                  <td>{r.extraction_confidence_pct ?? "—"}</td>
                  <td>{r.human_review_status}</td>
                  <td>
                    <input defaultValue={displayField(r, "first_name")} name={`fn-${r.id}`} style={{ width: "6rem" }} />
                  </td>
                  <td>
                    <input defaultValue={displayField(r, "last_name")} name={`ln-${r.id}`} style={{ width: "6rem" }} />
                  </td>
                  <td>
                    <input defaultValue={displayField(r, "full_name")} name={`fl-${r.id}`} style={{ width: "7rem" }} />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <input defaultValue={displayField(r, "birth_month")} name={`bm-${r.id}`} style={{ width: "2.2rem" }} />
                    /
                    <input defaultValue={displayField(r, "birth_day")} name={`bd-${r.id}`} style={{ width: "2.2rem" }} />
                    /
                    <input defaultValue={displayField(r, "birth_year")} name={`by-${r.id}`} style={{ width: "3rem" }} />
                  </td>
                  <td>
                    <input defaultValue={displayField(r, "address")} name={`ad-${r.id}`} style={{ width: "10rem" }} />
                  </td>
                  <td>
                    <input defaultValue={displayField(r, "city")} name={`ci-${r.id}`} style={{ width: "5rem" }} />
                  </td>
                  <td>
                    <input defaultValue={displayField(r, "state")} name={`st-${r.id}`} style={{ width: "2.5rem" }} />
                  </td>
                  <td>
                    <input defaultValue={displayField(r, "zip")} name={`zp-${r.id}`} style={{ width: "4rem" }} />
                  </td>
                  <td>
                    <input defaultValue={displayField(r, "signed_at")} name={`sd-${r.id}`} style={{ width: "6rem" }} />
                  </td>
                  <td>
                    <input defaultValue={displayField(r, "notes")} name={`no-${r.id}`} style={{ width: "6rem" }} />
                  </td>
                  <td style={{ fontSize: "0.7rem", color: "var(--muted)" }}>{unc || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy !== null}
                      onClick={() => {
                        const q = (name: string) =>
                          (document.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? "";
                        void patchRow(r.id, {
                          fields: {
                            first_name: q(`fn-${r.id}`) || null,
                            last_name: q(`ln-${r.id}`) || null,
                            full_name: q(`fl-${r.id}`) || null,
                            birth_month: q(`bm-${r.id}`) || null,
                            birth_day: q(`bd-${r.id}`) || null,
                            birth_year: q(`by-${r.id}`) || null,
                            address: q(`ad-${r.id}`) || null,
                            city: q(`ci-${r.id}`) || null,
                            state: q(`st-${r.id}`) || null,
                            zip: q(`zp-${r.id}`) || null,
                            signed_at: q(`sd-${r.id}`) || null,
                            notes: q(`no-${r.id}`) || null,
                          },
                          human_review_status: "EDITED",
                        });
                      }}
                    >
                      {busy === r.id ? "…" : "Save"}
                    </button>{" "}
                    <button type="button" className="primary" disabled={busy !== null} onClick={() => void patchRow(r.id, { action: "confirm" })}>
                      Confirm
                    </button>{" "}
                    <button type="button" disabled={busy !== null} onClick={() => void patchRow(r.id, { action: "reject" })}>
                      Reject
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
