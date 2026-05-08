import type { PoolClient } from "pg";

/** Values written to voter_petition_signature_events.event_type */
export type SignatureEventType =
  | "AUTO_UPSERT_FROM_IMPORT"
  | "MANUAL_ATTACH_FROM_REVIEW"
  | "MANUAL_REVIEW_NOTE"
  | "DUPLICATE_IMPORT_UPDATE"
  | "DETACH_REQUESTED"
  | "SYSTEM_BACKFILL";

export type ImportReviewAction =
  | "APPROVE_MATCH"
  | "REJECT_MATCH"
  | "MARK_NEEDS_MORE_INFO"
  | "ADD_NOTE"
  | "ATTACH_SIGNATURE"
  | "DETACH_SIGNATURE_REQUESTED"
  | "SUPERSEDE_REVIEW";

export async function insertSignatureEvent(
  client: PoolClient,
  params: {
    voterPetitionSignatureId: string | null;
    voterId: string;
    petitionId: string;
    petitionCode: string;
    importBatchId: string | null;
    importRowId: string | null;
    eventType: SignatureEventType;
    actor: string | null;
    eventNote: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO voter_petition_signature_events (
      voter_petition_signature_id, voter_id, petition_id, petition_code,
      import_batch_id, import_row_id, event_type, actor, event_note, metadata
    ) VALUES (
      $1::uuid, $2, $3::uuid, $4,
      $5::uuid, $6::uuid, $7, $8, $9, $10::jsonb
    )`,
    [
      params.voterPetitionSignatureId,
      params.voterId,
      params.petitionId,
      params.petitionCode,
      params.importBatchId,
      params.importRowId,
      params.eventType,
      params.actor,
      params.eventNote,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
}

/** Non-fatal: merge failure note into import_voter_matches.metadata */
export async function recordSignatureEventFailureOnMatch(
  client: PoolClient,
  importVoterMatchId: string,
  errMessage: string
): Promise<void> {
  const patch = {
    signature_event_insert_failed_at: new Date().toISOString(),
    signature_event_insert_error: errMessage.slice(0, 500),
  };
  await client.query(
    `UPDATE import_voter_matches
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1::uuid`,
    [importVoterMatchId, JSON.stringify(patch)]
  );
}

export async function insertImportMatchReview(
  client: PoolClient,
  params: {
    importBatchId: string;
    importRowId: string;
    importVoterMatchId: string | null;
    action: ImportReviewAction;
    previousMatchStatus: string | null;
    previousReviewStatus: string | null;
    selectedVoterId: string | null;
    selectedPetitionId: string | null;
    selectedPetitionCode: string | null;
    reviewedBy: string | null;
    reviewNote: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO import_match_reviews (
      import_batch_id, import_row_id, import_voter_match_id,
      action, previous_match_status, previous_review_status,
      selected_voter_id, selected_petition_id, selected_petition_code,
      reviewed_by, review_note, metadata
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid,
      $4, $5, $6,
      $7, $8::uuid, $9,
      $10, $11, $12::jsonb
    )`,
    [
      params.importBatchId,
      params.importRowId,
      params.importVoterMatchId,
      params.action,
      params.previousMatchStatus,
      params.previousReviewStatus,
      params.selectedVoterId,
      params.selectedPetitionId,
      params.selectedPetitionCode,
      params.reviewedBy,
      params.reviewNote,
      JSON.stringify(params.metadata ?? {}),
    ]
  );
}
