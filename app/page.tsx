import { UploadForm } from "@/components/UploadForm";

export default function HomePage() {
  return (
    <main className="page">
      <div className="page-hero">
        <h1>Import petition sheets</h1>
        <p>
          Upload a <strong>Petition Mail List Share</strong> spreadsheet, or a clear photo of a handwritten /
          printed sheet. Photos are converted on the server with OpenAI vision (requires{" "}
          <code>OPENAI_API_KEY</code>), then run through the same matching pipeline as the CLI.
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
