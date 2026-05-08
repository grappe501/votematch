import type { PoolClient } from "pg";
import type { NormalizedRowJson, RawRowJson } from "./types.js";

export async function ensurePetition(
  client: PoolClient,
  params: {
    petitionCode: string;
    petitionName: string;
    projectKey: string | null;
  }
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO petitions (petition_code, petition_name, project_key, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (petition_code) DO UPDATE SET
       petition_name = EXCLUDED.petition_name,
       project_key = COALESCE(EXCLUDED.project_key, petitions.project_key),
       updated_at = now()
     RETURNING id`,
    [params.petitionCode, params.petitionName, params.projectKey]
  );
  return r.rows[0]!.id;
}

export async function upsertPetitionSignature(
  client: PoolClient,
  params: {
    voterId: string;
    petitionId: string;
    petitionCode: string;
    importBatchId: string;
    importRowId: string;
    sourceProjectKey: string;
    sourceLabel: string | null;
    sourceFileName: string;
    normalized: NormalizedRowJson;
    raw: RawRowJson;
    matchMethod: string | null;
    matchConfidence: number | null;
    signerFirstName: string | null;
    signerLastName: string | null;
    signerFullName: string | null;
    signerAddress: string | null;
    signerCity: string | null;
    signerCounty: string | null;
    signerState: string | null;
    signerZip: string | null;
    signedAt: string | null;
    voterWard?: string | null;
    voterPrecinct?: string | null;
    voterDistrict?: string | null;
    matchConfidencePct?: number | null;
    jurisdictionStatus?: string | null;
    duplicateStatus?: string | null;
  }
): Promise<{ signatureId: string; existedBefore: boolean }> {
  const prior = await client.query<{ id: string }>(
    `SELECT id FROM voter_petition_signatures
     WHERE voter_id = $1 AND petition_id = $2::uuid`,
    [params.voterId, params.petitionId]
  );
  const existedBefore = prior.rows.length > 0;

  const ins = await client.query<{ id: string }>(
    `INSERT INTO voter_petition_signatures (
      voter_id, petition_id, petition_code,
      import_batch_id, import_row_id,
      source_project_key, source_label, source_file_name,
      signed_at,
      signer_first_name, signer_last_name, signer_full_name,
      signer_address, signer_city, signer_county, signer_state, signer_zip,
      raw_row_json, normalized_json,
      match_method, match_confidence,
      voter_ward, voter_precinct, voter_district,
      match_confidence_pct,
      jurisdiction_status, duplicate_status,
      updated_at
    ) VALUES (
      $1, $2::uuid, $3,
      $4::uuid, $5::uuid,
      $6, $7, $8,
      $9::date,
      $10, $11, $12,
      $13, $14, $15, $16, $17,
      $18::jsonb, $19::jsonb,
      $20, $21,
      $22, $23, $24,
      $25, $26, $27,
      now()
    )
    ON CONFLICT (voter_id, petition_id) DO UPDATE SET
      import_batch_id = EXCLUDED.import_batch_id,
      import_row_id = EXCLUDED.import_row_id,
      source_project_key = EXCLUDED.source_project_key,
      source_label = EXCLUDED.source_label,
      source_file_name = EXCLUDED.source_file_name,
      signed_at = EXCLUDED.signed_at,
      signer_first_name = EXCLUDED.signer_first_name,
      signer_last_name = EXCLUDED.signer_last_name,
      signer_full_name = EXCLUDED.signer_full_name,
      signer_address = EXCLUDED.signer_address,
      signer_city = EXCLUDED.signer_city,
      signer_county = EXCLUDED.signer_county,
      signer_state = EXCLUDED.signer_state,
      signer_zip = EXCLUDED.signer_zip,
      raw_row_json = EXCLUDED.raw_row_json,
      normalized_json = EXCLUDED.normalized_json,
      match_method = EXCLUDED.match_method,
      match_confidence = EXCLUDED.match_confidence,
      voter_ward = COALESCE(EXCLUDED.voter_ward, voter_petition_signatures.voter_ward),
      voter_precinct = COALESCE(EXCLUDED.voter_precinct, voter_petition_signatures.voter_precinct),
      voter_district = COALESCE(EXCLUDED.voter_district, voter_petition_signatures.voter_district),
      match_confidence_pct = COALESCE(EXCLUDED.match_confidence_pct, voter_petition_signatures.match_confidence_pct),
      jurisdiction_status = COALESCE(EXCLUDED.jurisdiction_status, voter_petition_signatures.jurisdiction_status),
      duplicate_status = COALESCE(EXCLUDED.duplicate_status, voter_petition_signatures.duplicate_status),
      updated_at = now()
    RETURNING id`,
    [
      params.voterId,
      params.petitionId,
      params.petitionCode,
      params.importBatchId,
      params.importRowId,
      params.sourceProjectKey,
      params.sourceLabel,
      params.sourceFileName,
      params.signedAt,
      params.signerFirstName,
      params.signerLastName,
      params.signerFullName,
      params.signerAddress,
      params.signerCity,
      params.signerCounty,
      params.signerState,
      params.signerZip,
      JSON.stringify(params.raw),
      JSON.stringify(params.normalized),
      params.matchMethod,
      params.matchConfidence,
      params.voterWard ?? null,
      params.voterPrecinct ?? null,
      params.voterDistrict ?? null,
      params.matchConfidencePct ?? null,
      params.jurisdictionStatus ?? null,
      params.duplicateStatus ?? null,
    ]
  );
  return { signatureId: ins.rows[0]!.id, existedBefore };
}
