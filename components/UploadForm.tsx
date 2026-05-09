"use client";

import { useEffect, useState } from "react";

type Health = {
  ok: boolean;
  ingest_requires_token: boolean;
  database_configured: boolean;
  vision_conversion_available?: boolean;
};

export function UploadForm() {
  const [health, setHealth] = useState<Health | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [petitionCode, setPetitionCode] = useState("");
  const [petitionName, setPetitionName] = useState("");
  const [projectKey, setProjectKey] = useState("sos");
  const [sourceLabel, setSourceLabel] = useState("");
  const [autoCreate, setAutoCreate] = useState(false);
  const [initiativeScope, setInitiativeScope] = useState("COUNTY");
  const [reportingGeo, setReportingGeo] = useState("COUNTY");

  useEffect(() => {
    void fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth({ ok: false, ingest_requires_token: true, database_configured: false }));
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setMessage("Choose a spreadsheet or image file.");
      return;
    }
    if (health?.ingest_requires_token && !token.trim()) {
      setMessage("Upload token is required (set VFM_UPLOAD_TOKEN on the server and paste it here).");
      return;
    }
    setBusy(true);
    try {
      const headers: Record<string, string> = {};
      if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
      const res = await fetch("/api/ingest", { method: "POST", body: fd, headers });
      const body = (await res.json()) as {
        error?: string;
        ok?: boolean;
        converted_from_image?: boolean;
        result?: Record<string, unknown>;
      };
      if (!res.ok) {
        setMessage(body.error ?? `Import failed (${res.status})`);
        return;
      }
      const bid = String(body.result?.batch_id ?? "");
      setMessage(
        body.converted_from_image
          ? `Photo converted and imported. batch_id=${bid} — open Reports to review counts and follow-up rows.`
          : `Import complete. batch_id=${bid} — open Reports for org-level totals.`
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>Upload</h2>
      <p style={{ margin: "0 0 0.5rem", color: "var(--muted)", fontSize: "0.92rem" }}>
        Spreadsheets: <strong>.csv</strong>, <strong>.xlsx</strong>, <strong>.xls</strong> (Petition Mail List Share
        profile). Images: <strong>JPEG / PNG / WebP</strong> — server builds a workbook using OpenAI vision when{" "}
        <code>OPENAI_API_KEY</code> is configured.
      </p>
      {health && (
        <p style={{ margin: "0 0 0.75rem", color: "var(--muted)", fontSize: "0.88rem" }}>
          DB: <strong>{health.database_configured ? "connected" : "not configured"}</strong>
          {" · "}
          Photo conversion:{" "}
          <strong>{health.vision_conversion_available ? "available" : "needs OPENAI_API_KEY"}</strong>
          {health.ingest_requires_token ? " · Upload token required" : ""}
        </p>
      )}
      {health?.ingest_requires_token && (
        <>
          <label htmlFor="upload-token">Upload token</label>
          <input id="upload-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </>
      )}
      <label htmlFor="file">File</label>
      <input
        id="file"
        name="file"
        type="file"
        accept=".csv,.xlsx,.xls,image/jpeg,image/png,image/webp,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        required
      />
      <label htmlFor="petitionCode">Petition code</label>
      <input id="petitionCode" name="petitionCode" type="text" value={petitionCode} onChange={(e) => setPetitionCode(e.target.value)} required autoComplete="off" />
      <label htmlFor="petitionName">Petition display name</label>
      <input id="petitionName" name="petitionName" type="text" value={petitionName} onChange={(e) => setPetitionName(e.target.value)} required />
      <label htmlFor="projectKey">Organization (project key)</label>
      <input id="projectKey" name="projectKey" type="text" value={projectKey} onChange={(e) => setProjectKey(e.target.value)} required />
      <label htmlFor="sourceLabel">Source label (optional)</label>
      <input id="sourceLabel" name="sourceLabel" type="text" value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} />
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.75rem" }}>
        <input type="checkbox" name="autoCreateInitiative" value="true" checked={autoCreate} onChange={(e) => setAutoCreate(e.target.checked)} />
        Auto-create initiative if missing
      </label>
      {autoCreate && (
        <>
          <label htmlFor="initiativeScope">Initiative scope</label>
          <select id="initiativeScope" name="initiativeScope" value={initiativeScope} onChange={(e) => setInitiativeScope(e.target.value)}>
            <option value="CITY">CITY</option>
            <option value="COUNTY">COUNTY</option>
            <option value="STATEWIDE">STATEWIDE</option>
            <option value="DISTRICT">DISTRICT</option>
            <option value="OTHER">OTHER</option>
          </select>
          <label htmlFor="reportingGeo">Reporting geo</label>
          <select id="reportingGeo" name="reportingGeo" value={reportingGeo} onChange={(e) => setReportingGeo(e.target.value)}>
            <option value="WARD">WARD</option>
            <option value="COUNTY">COUNTY</option>
            <option value="PRECINCT">PRECINCT</option>
            <option value="DISTRICT">DISTRICT</option>
            <option value="CITY">CITY</option>
            <option value="NONE">NONE</option>
          </select>
        </>
      )}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? "Working…" : "Run import"}
      </button>
      {message && (
        <p style={{ marginTop: "1rem", color: "var(--fg)" }}>
          {message}{" "}
          <a href="/reports" style={{ marginLeft: "0.35rem" }}>
            Open reports →
          </a>
        </p>
      )}
    </form>
  );
}
