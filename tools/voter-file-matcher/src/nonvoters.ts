import type { PoolClient } from "pg";
import type { NormalizedRowJson, RawRowJson } from "./types.js";

export type NonvoterReason = string;

export async function insertInitiativeNonvoterEntry(
  client: PoolClient,
  opts: {
    petitionId: string;
    petitionCode: string;
    importBatchId: string | null;
    importRowId: string | null;
    importVoterMatchId: string | null;
    sourceFileName: string | null;
    rowNumber: number | null;
    signerFirstName: string | null;
    signerLastName: string | null;
    signerFullName: string | null;
    signerAddress: string | null;
    signerCity: string | null;
    signerCounty: string | null;
    signerState: string | null;
    signerZip: string | null;
    signedAt: string | null;
    reason: NonvoterReason;
    reviewedBy: string | null;
    reviewNote: string | null;
    rawRowJson: RawRowJson;
    normalizedJson: NormalizedRowJson;
    metadata?: Record<string, unknown>;
  }
): Promise<{ id: string }> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO initiative_nonvoter_entries (
      petition_id, petition_code, import_batch_id, import_row_id, import_voter_match_id,
      source_file_name, row_number,
      signer_first_name, signer_last_name, signer_full_name,
      signer_address, signer_city, signer_county, signer_state, signer_zip,
      signed_at, reason, reviewed_by, review_note, raw_row_json, normalized_json, metadata
    ) VALUES (
      $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid,
      $6, $7,
      $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16::date, $17, $18, $19, $20::jsonb, $21::jsonb, $22::jsonb
    ) RETURNING id`,
    [
      opts.petitionId,
      opts.petitionCode,
      opts.importBatchId,
      opts.importRowId,
      opts.importVoterMatchId,
      opts.sourceFileName,
      opts.rowNumber,
      opts.signerFirstName,
      opts.signerLastName,
      opts.signerFullName,
      opts.signerAddress,
      opts.signerCity,
      opts.signerCounty,
      opts.signerState,
      opts.signerZip,
      opts.signedAt && /^\d{4}-\d{2}-\d{2}/.test(opts.signedAt) ? opts.signedAt.slice(0, 10) : null,
      opts.reason,
      opts.reviewedBy,
      opts.reviewNote,
      JSON.stringify(opts.rawRowJson ?? {}),
      JSON.stringify(opts.normalizedJson ?? {}),
      JSON.stringify(opts.metadata ?? {}),
    ]
  );
  return { id: r.rows[0]!.id };
}

export type NonvoterReportRow = {
  row_number: number | null;
  first_name: string | null;
  last_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  signed_at: string | null;
  reason: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  note: string | null;
};

export async function fetchNonvoterEntriesForPetition(
  client: Pick<PoolClient, "query">,
  petitionCode: string
): Promise<NonvoterReportRow[]> {
  const r = await client.query<NonvoterReportRow>(
    `SELECT row_number, signer_first_name AS first_name, signer_last_name AS last_name,
            signer_address AS address, signer_city AS city, signer_state AS state, signer_zip AS zip,
            signed_at::text AS signed_at, reason, reviewed_by, reviewed_at::text AS reviewed_at,
            review_note AS note
     FROM initiative_nonvoter_entries
     WHERE petition_code = $1
     ORDER BY created_at ASC`,
    [petitionCode.trim()]
  );
  return r.rows;
}
