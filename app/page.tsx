import { UploadForm } from "@/components/UploadForm";

export default function HomePage() {
  return (
    <main className="page">
      <div className="page-hero">
        <h1>Import petition sheets</h1>
        <p>
          Upload a <strong>Petition Mail List Share</strong> spreadsheet for immediate matching, or a <strong>JPEG / PNG</strong>{" "}
          scan for <strong>OCR intake</strong> (OpenAI vision on the server). OCR produces draft rows that must be reviewed and
          confirmed before they enter the same import/match pipeline as CSV/XLSX—raw OCR never creates permanent signatures by
          itself.
        </p>
      </div>
      <div className="banner">
        Files under <code>spreadsheets/</code> on disk are <strong>not</strong> imported automatically—run an
        import from this page or use <code>npm run voter-match -- --file …</code> with a path to your workbook.
      </div>
      <div className="banner danger">
        Production: set <code>VFM_UPLOAD_TOKEN</code> on the host and paste it here when prompted. Never put{" "}
        <code>DATABASE_URL</code> in the browser.
      </div>
      <UploadForm />
    </main>
  );
}
