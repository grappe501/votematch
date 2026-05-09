import type { Pool } from "pg";

export type OcrRowUpdateFields = {
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  birth_month?: string | null;
  birth_day?: string | null;
  birth_year?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  signed_at?: string | null;
  notes?: string | null;
};

export async function updateOcrRowCorrection(
  pool: Pool,
  params: {
    batchId: string;
    rowId: string;
    fields: OcrRowUpdateFields;
    correctedBy: string | null;
    /** When saving edits without final confirm, use EDITED. */
    human_review_status: "EDITED" | "CONFIRMED" | "NEEDS_REVIEW";
  }
): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM ocr_extracted_rows
     WHERE id = $1::uuid AND ocr_image_batch_id = $2::uuid`,
    [params.rowId, params.batchId]
  );
  if (r.rows.length === 0) return false;

  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params.fields)) {
    if (v !== undefined) merged[k] = v;
  }

  await pool.query(
    `UPDATE ocr_extracted_rows
     SET corrected_json = corrected_json || $1::jsonb,
         corrected_by = COALESCE($2::text, corrected_by),
         corrected_at = now(),
         human_review_status = $3::text,
         needs_human_review = CASE
           WHEN $3::text = 'CONFIRMED' OR $3::text = 'REJECTED' OR $3::text = 'CANCELLED' THEN false
           WHEN $3::text = 'EDITED' THEN true
           ELSE true
         END
     WHERE id = $4::uuid`,
    [JSON.stringify(merged), params.correctedBy, params.human_review_status, params.rowId]
  );
  return true;
}

export async function confirmOcrRow(pool: Pool, batchId: string, rowId: string, correctedBy: string | null): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM ocr_extracted_rows
     WHERE id = $1::uuid AND ocr_image_batch_id = $2::uuid
       AND human_review_status IN ('NEEDS_REVIEW','EDITED')`,
    [rowId, batchId]
  );
  if (r.rows.length === 0) return false;
  await pool.query(
    `UPDATE ocr_extracted_rows
     SET human_review_status = 'CONFIRMED',
         corrected_by = COALESCE($1::text, corrected_by),
         corrected_at = now(),
         needs_human_review = false
     WHERE id = $2::uuid`,
    [correctedBy, rowId]
  );
  return true;
}

export async function rejectOcrRow(pool: Pool, batchId: string, rowId: string, correctedBy: string | null): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM ocr_extracted_rows WHERE id = $1::uuid AND ocr_image_batch_id = $2::uuid`,
    [rowId, batchId]
  );
  if (r.rows.length === 0) return false;
  await pool.query(
    `UPDATE ocr_extracted_rows
     SET human_review_status = 'REJECTED',
         needs_human_review = false,
         corrected_by = COALESCE($1::text, corrected_by),
         corrected_at = now()
     WHERE id = $2::uuid`,
    [correctedBy, rowId]
  );
  return true;
}

export async function confirmAllReviewedRows(
  pool: Pool,
  batchId: string,
  correctedBy: string | null
): Promise<number> {
  const u = await pool.query(
    `UPDATE ocr_extracted_rows
     SET human_review_status = 'CONFIRMED',
         corrected_by = COALESCE($1::text, corrected_by),
         corrected_at = now()
     WHERE ocr_image_batch_id = $2::uuid
       AND human_review_status = 'EDITED'
     RETURNING id`,
    [correctedBy, batchId]
  );
  return u.rowCount ?? 0;
}

export async function listOcrRowsNeedingReview(pool: Pool, batchId: string) {
  const r = await pool.query(
    `SELECT * FROM ocr_rows_needing_review WHERE ocr_image_batch_id = $1::uuid ORDER BY row_number ASC`,
    [batchId]
  );
  return r.rows;
}

export async function getOcrReviewProgress(pool: Pool, batchId: string) {
  const r = await pool.query<{
    total: string;
    needs: string;
    confirmed: string;
    edited: string;
    rejected: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE human_review_status = 'NEEDS_REVIEW')::text AS needs,
       COUNT(*) FILTER (WHERE human_review_status = 'CONFIRMED')::text AS confirmed,
       COUNT(*) FILTER (WHERE human_review_status = 'EDITED')::text AS edited,
       COUNT(*) FILTER (WHERE human_review_status = 'REJECTED')::text AS rejected
     FROM ocr_extracted_rows WHERE ocr_image_batch_id = $1::uuid`,
    [batchId]
  );
  const x = r.rows[0]!;
  return {
    total: Number.parseInt(x.total, 10) || 0,
    needs_review: Number.parseInt(x.needs, 10) || 0,
    confirmed: Number.parseInt(x.confirmed, 10) || 0,
    edited: Number.parseInt(x.edited, 10) || 0,
    rejected: Number.parseInt(x.rejected, 10) || 0,
  };
}
