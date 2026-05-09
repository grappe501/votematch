import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Pool } from "pg";
import { extractPetitionRowsFromImage } from "./ocrOpenAI.js";
import type { OcrExtractedRowJson, OcrPetitionExtractionResult } from "./ocrTypes.js";
import { loadHeaderMapFile } from "./headerMap.js";
import { runFullImport } from "./importRunner.js";
import { computeSha256Hex, saveOcrUploadFile } from "./ocrStorage.js";

function csvEscape(s: string): string {
  const t = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

const PETITION_MAIL_HEADERS = [
  "PRINTED FIRST NAME",
  "PRINTED LAST NAME",
  "BIRTH MONTH",
  "BIRTH DAY",
  "BIRTH YEAR",
  "CITY",
  "STATE",
  "STREET ADDRESS",
  "ZIPCODE",
  "DATE SIGNED",
  "NOTES",
] as const;

type OcrRowRecord = {
  id: string;
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
  corrected_json: Record<string, unknown> | null;
};

function pickText(row: OcrRowRecord, key: string): string {
  const cj = row.corrected_json;
  if (cj && typeof cj[key] === "string" && cj[key]!.trim().length > 0) return String(cj[key]).trim();
  const v = (row as unknown as Record<string, unknown>)[key];
  if (v == null) return "";
  return String(v).trim();
}

/** Build Petition Mail List Share CSV for runFullImport (UTF-8). */
export function buildPetitionMailCsvFromOcrRows(rows: OcrRowRecord[]): string {
  const lines = [PETITION_MAIL_HEADERS.map(csvEscape).join(",")];
  for (const row of rows) {
    const cells = [
      pickText(row, "first_name"),
      pickText(row, "last_name"),
      pickText(row, "birth_month"),
      pickText(row, "birth_day"),
      pickText(row, "birth_year"),
      pickText(row, "city"),
      pickText(row, "state"),
      pickText(row, "address"),
      pickText(row, "zip"),
      pickText(row, "signed_at"),
      pickText(row, "notes"),
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

export async function assertPetitionExists(pool: Pool, petitionCode: string): Promise<{
  petition_id: string;
  petition_name: string;
  project_key: string | null;
} | null> {
  const r = await pool.query<{ id: string; petition_name: string; project_key: string | null }>(
    `SELECT id, petition_name, project_key FROM petitions WHERE petition_code = $1`,
    [petitionCode]
  );
  if (r.rows.length === 0) return null;
  const x = r.rows[0]!;
  return { petition_id: x.id, petition_name: x.petition_name, project_key: x.project_key };
}

export async function createOcrImageBatch(
  pool: Pool,
  params: {
    projectKey: string;
    petitionId: string;
    petitionCode: string;
    sourceLabel: string | null;
    originalFileName: string;
    fileHash: string;
    mimeType: string;
    fileSize: number;
    createdBy: string | null;
  }
): Promise<string> {
  const ins = await pool.query<{ id: string }>(
    `INSERT INTO ocr_image_batches (
       project_key, petition_id, petition_code, source_label,
       original_file_name, file_hash, mime_type, file_size,
       status, human_review_status, created_by
     ) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,'UPLOADED','NEEDS_REVIEW',$9)
     RETURNING id::text`,
    [
      params.projectKey,
      params.petitionId,
      params.petitionCode,
      params.sourceLabel,
      params.originalFileName,
      params.fileHash,
      params.mimeType,
      params.fileSize,
      params.createdBy,
    ]
  );
  return ins.rows[0]!.id;
}

export async function createOcrImageFile(
  pool: Pool,
  params: {
    batchId: string;
    originalFileName: string;
    storedFilePath: string | null;
    fileHash: string;
    mimeType: string;
    fileSize: number;
  }
): Promise<string> {
  const ins = await pool.query<{ id: string }>(
    `INSERT INTO ocr_image_files (
       ocr_image_batch_id, original_file_name, stored_file_path, file_hash, mime_type, file_size, page_number
     ) VALUES ($1::uuid,$2,$3,$4,$5,$6,1)
     RETURNING id::text`,
    [params.batchId, params.originalFileName, params.storedFilePath, params.fileHash, params.mimeType, params.fileSize]
  );
  return ins.rows[0]!.id;
}

export async function saveExtractedRows(
  pool: Pool,
  params: {
    batchId: string;
    ocrImageFileId: string | null;
    extraction: OcrPetitionExtractionResult;
  }
): Promise<number> {
  let n = 0;
  for (const row of params.extraction.rows) {
    await insertOneExtractedRow(pool, params.batchId, params.ocrImageFileId, row);
    n += 1;
  }
  return n;
}

async function insertOneExtractedRow(
  pool: Pool,
  batchId: string,
  fileId: string | null,
  row: OcrExtractedRowJson
): Promise<void> {
  const uncertain = JSON.stringify(row.uncertain_fields ?? []);
  const rawJson = JSON.stringify(row);
  await pool.query(
    `INSERT INTO ocr_extracted_rows (
       ocr_image_batch_id, ocr_image_file_id, row_number,
       extraction_confidence_pct, needs_human_review, human_review_status,
       first_name, last_name, full_name, birth_month, birth_day, birth_year,
       address, city, state, zip, signed_at, notes,
       uncertain_fields, raw_line_text, raw_extraction_json, normalized_json, qa_flags
     ) VALUES (
       $1::uuid, $2::uuid, $3,
       $4, true, 'NEEDS_REVIEW',
       $5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,$16,
       $17::jsonb, $18, $19::jsonb, '{}'::jsonb, '[]'::jsonb
     )`,
    [
      batchId,
      fileId,
      row.row_number,
      row.extraction_confidence_pct,
      row.first_name,
      row.last_name,
      row.full_name,
      row.birth_month,
      row.birth_day,
      row.birth_year,
      row.address,
      row.city,
      row.state,
      row.zip,
      row.signed_at,
      row.notes,
      uncertain,
      row.raw_line_text,
      rawJson,
    ]
  );
}

export async function runOcrForImageBatch(pool: Pool, batchId: string, fileId: string): Promise<OcrPetitionExtractionResult> {
  const model = process.env.OPENAI_OCR_MODEL?.trim();
  if (!model) throw new Error("OPENAI_OCR_MODEL is not set.");

  const f = await pool.query<{ path: string | null; mime: string; petition_code: string; petition_name: string | null }>(
    `SELECT f.stored_file_path AS path, f.mime_type AS mime, b.petition_code, p.petition_name
     FROM ocr_image_files f
     INNER JOIN ocr_image_batches b ON b.id = f.ocr_image_batch_id
     LEFT JOIN petitions p ON p.id = b.petition_id
     WHERE f.id = $1::uuid`,
    [fileId]
  );
  if (f.rows.length === 0 || !f.rows[0]?.path) {
    throw new Error("OCR image file not found or not stored on disk.");
  }
  const row = f.rows[0]!;
  if (!row.path) {
    throw new Error("OCR image file not found or not stored on disk.");
  }
  const buf = await readFile(row.path);
  const mime = row.mime === "image/png" ? ("image/png" as const) : ("image/jpeg" as const);

  await pool.query(
    `UPDATE ocr_image_batches SET status = 'OCR_RUNNING', ocr_started_at = now(), ocr_model = $2, updated_at = now() WHERE id = $1::uuid`,
    [batchId, model]
  );

  try {
    const extraction = await extractPetitionRowsFromImage({
      imageBuffer: buf,
      mimeType: mime,
      model,
      petitionContext: {
        petition_code: row.petition_code,
        petition_name: row.petition_name,
      },
    });
    await saveExtractedRows(pool, { batchId, ocrImageFileId: fileId, extraction });
    await pool.query(
      `UPDATE ocr_image_batches SET status = 'OCR_COMPLETED', ocr_completed_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [batchId]
    );
    return extraction;
  } catch (e) {
    await pool.query(
      `UPDATE ocr_image_batches SET status = 'OCR_FAILED', ocr_completed_at = now(), updated_at = now(), metadata = metadata || $2::jsonb WHERE id = $1::uuid`,
      [
        batchId,
        JSON.stringify({
          ocr_error: e instanceof Error ? e.message : String(e),
        }),
      ]
    );
    throw e;
  }
}

export type OcrBatchSummaryRow = {
  batch_id: string;
  petition_code: string;
  original_file_name: string;
  status: string;
  human_review_status: string;
  total_extracted_rows: string;
  confirmed_rows: string;
  edited_rows: string;
  rejected_rows: string;
  avg_extraction_confidence_pct: string | null;
  created_at: string;
};

export async function getOcrBatchSummary(pool: Pool, batchId: string): Promise<OcrBatchSummaryRow | null> {
  try {
    const r = await pool.query<OcrBatchSummaryRow>(
      `SELECT batch_id::text, petition_code, original_file_name, status, human_review_status,
              total_extracted_rows::text, confirmed_rows::text, edited_rows::text, rejected_rows::text,
              avg_extraction_confidence_pct::text, created_at::text
       FROM ocr_batch_summary WHERE batch_id = $1::uuid`,
      [batchId]
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function getOcrBatchMeta(pool: Pool, batchId: string) {
  const r = await pool.query<{
    id: string;
    petition_code: string;
    original_file_name: string;
    status: string;
    human_review_status: string;
    project_key: string;
    created_at: string;
  }>(
    `SELECT id::text, petition_code, original_file_name, status, human_review_status, project_key, created_at::text
     FROM ocr_image_batches WHERE id = $1::uuid`,
    [batchId]
  );
  return r.rows[0] ?? null;
}

export async function getOcrRowsForReview(pool: Pool, batchId: string) {
  const r = await pool.query(
    `SELECT * FROM ocr_extracted_rows WHERE ocr_image_batch_id = $1::uuid ORDER BY row_number ASC`,
    [batchId]
  );
  return r.rows;
}

export async function bulkConfirmOcrRowsForImport(
  pool: Pool,
  batchId: string,
  rowIds: string[] | null,
  correctedBy: string | null
): Promise<number> {
  if (rowIds && rowIds.length > 0) {
    const u = await pool.query(
      `UPDATE ocr_extracted_rows
       SET human_review_status = 'CONFIRMED',
           needs_human_review = false,
           corrected_by = COALESCE($1::text, corrected_by),
           corrected_at = now()
       WHERE ocr_image_batch_id = $2::uuid
         AND id = ANY($3::uuid[])
         AND human_review_status IN ('NEEDS_REVIEW','EDITED')`,
      [correctedBy, batchId, rowIds]
    );
    return u.rowCount ?? 0;
  }
  const u = await pool.query(
    `UPDATE ocr_extracted_rows
     SET human_review_status = 'CONFIRMED',
         needs_human_review = false,
         corrected_by = COALESCE($1::text, corrected_by),
         corrected_at = now()
     WHERE ocr_image_batch_id = $2::uuid
       AND human_review_status IN ('NEEDS_REVIEW','EDITED')`,
    [correctedBy, batchId]
  );
  return u.rowCount ?? 0;
}

export type ConfirmOcrImportResult = {
  import_batch_id: string;
  report_dir: string;
  rows_imported: number;
};

/**
 * Converts human-confirmed OCR rows into a temp CSV and runs the normal import/match pipeline.
 * Does not write voter_petition_signatures except via existing runFullImport behavior.
 */
export async function confirmOcrRowsToImport(params: {
  pool: Pool;
  batchId: string;
  mapPath: string;
  mapRel: string;
  createdBy: string | null;
  chunkSize: number;
}): Promise<ConfirmOcrImportResult> {
  const { pool, batchId, mapPath, mapRel, createdBy, chunkSize } = params;

  const batch = await pool.query<{
    petition_code: string;
    project_key: string;
    petition_id: string | null;
  }>(
    `SELECT petition_code, project_key, petition_id::text FROM ocr_image_batches WHERE id = $1::uuid`,
    [batchId]
  );
  if (batch.rows.length === 0) throw new Error("OCR batch not found.");
  const b = batch.rows[0]!;
  const pet = await assertPetitionExists(pool, b.petition_code);
  if (!pet) throw new Error("Petition no longer exists.");

  const rows = await pool.query<OcrRowRecord>(
    `SELECT id, first_name, last_name, full_name, birth_month, birth_day, birth_year,
            address, city, state, zip, signed_at, notes, corrected_json
     FROM ocr_extracted_rows
     WHERE ocr_image_batch_id = $1::uuid
       AND human_review_status IN ('CONFIRMED','EDITED')`,
    [batchId]
  );
  if (rows.rows.length === 0) {
    throw new Error("No CONFIRMED or EDITED rows to import. Confirm rows in review first.");
  }

  const csv = buildPetitionMailCsvFromOcrRows(rows.rows);
  const tmpCsv = join(tmpdir(), `ocr-import-${batchId}-${randomUUID()}.csv`);
  await writeFile(tmpCsv, csv, "utf8");

  const mapFile = await loadHeaderMapFile(mapPath);
  const sourceLabel = `OCR image batch ${batchId}`;

  try {
    const result = await runFullImport({
      filePath: tmpCsv,
      mapPath: mapRel,
      mapFile,
      petitionCode: b.petition_code,
      petitionName: pet.petition_name,
      projectKey: b.project_key || pet.project_key || "sos",
      sourceLabel,
      createdBy: createdBy ?? "ocr-import",
      chunkSize,
      autoCreateInitiative: false,
    });

    await pool.query(
      `INSERT INTO ocr_to_import_batches (ocr_image_batch_id, import_batch_id, metadata)
       VALUES ($1::uuid, $2::uuid, $3::jsonb)`,
      [batchId, result.batch_id, JSON.stringify({ row_count: rows.rows.length })]
    );

    await pool.query(
      `UPDATE ocr_extracted_rows
       SET metadata = metadata || jsonb_build_object('import_batch_id', $2::text)
       WHERE ocr_image_batch_id = $1::uuid AND human_review_status IN ('CONFIRMED','EDITED')`,
      [batchId, result.batch_id]
    );

    await pool.query(
      `UPDATE ocr_image_batches
       SET status = 'CONFIRMED_TO_IMPORT', human_review_status = 'REVIEWED', updated_at = now()
       WHERE id = $1::uuid`,
      [batchId]
    );

    return {
      import_batch_id: result.batch_id,
      report_dir: result.report_dir,
      rows_imported: rows.rows.length,
    };
  } finally {
    await unlink(tmpCsv).catch(() => undefined);
  }
}

/** Full upload + persist + OCR (used by API route after validation). */
export async function ingestImageAndRunOcr(params: {
  pool: Pool;
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png";
  originalFileName: string;
  projectKey: string;
  petitionCode: string;
  sourceLabel: string | null;
  createdBy: string | null;
}): Promise<{ batchId: string; fileId: string; extracted_row_count: number }> {
  const pet = await assertPetitionExists(params.pool, params.petitionCode);
  if (!pet) {
    throw new Error(`Petition not found for code ${params.petitionCode}. Create the initiative before OCR upload.`);
  }

  const fileHash = computeSha256Hex(params.buffer);
  const batchId = await createOcrImageBatch(params.pool, {
    projectKey: params.projectKey,
    petitionId: pet.petition_id,
    petitionCode: params.petitionCode,
    sourceLabel: params.sourceLabel,
    originalFileName: params.originalFileName,
    fileHash,
    mimeType: params.mimeType,
    fileSize: params.buffer.length,
    createdBy: params.createdBy,
  });

  const saved = await saveOcrUploadFile({
    batchId,
    originalFileName: params.originalFileName,
    buffer: params.buffer,
    mimeType: params.mimeType,
  });

  const fileId = await createOcrImageFile(params.pool, {
    batchId,
    originalFileName: params.originalFileName,
    storedFilePath: saved.stored_file_path,
    fileHash: saved.file_hash,
    mimeType: saved.mime_type,
    fileSize: saved.file_size,
  });

  const extraction = await runOcrForImageBatch(params.pool, batchId, fileId);
  return { batchId, fileId, extracted_row_count: extraction.rows.length };
}
