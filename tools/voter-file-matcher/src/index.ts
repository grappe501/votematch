/**
 * Voter file matcher + petition signature persistence (project-agnostic library surface).
 */
export type {
  VoterHeaderMapFile,
  NormalizedRowJson,
  RawRowJson,
  ParsedSheet,
  MatchOutcome,
  MatchStatus,
  ImportReviewStatus,
  SummaryReportJson,
  CsvReportRow,
  CanonicalColumnMap,
  HeaderAliasMap,
  QaFlag,
  QaFlagsCsvRow,
  PreflightSummaryJson,
  SourceProfileNormalization,
  SourceProfileMatching,
  MatchingTierSet,
  ColumnLogicalKind,
  SchemaColumnMeta,
  RelatedTableDiscovery,
  DiscoverVoterSchemaResult,
  MatchSourcePlanJson,
  MatchSourcePlanConfidence,
  MatchSourcePlanColumnEntry,
  CandidateProbeSummary,
  ImportPlanJson,
  ImportPlanOperatorReviewStatus,
} from "./types.js";
export { loadVfmEnv } from "./env-load.js";
export {
  loadHeaderMapFile,
  buildHeaderIndex,
  columnSpecToIndex,
  pickFromColumnPositions,
  listPositionalMappingsApplied,
  mapRowWithAliases,
  serializeHeaderMapForDb,
} from "./headerMap.js";
export { runValidateConfig, runValidateDb, validateCanonicalPhysicalColumns } from "./validation.js";
export {
  createPool,
  qualifiedTableSql,
  colExpr,
  assertSqlIdent,
  parseQualifiedTable,
  fetchTableColumnNames,
} from "./db.js";
export { parseVoterFile, parseVoterBuffer } from "./parseFile.js";
export type { ParseFileOptions } from "./parseFile.js";
export { chunkArray, chunkNumberForRowIndex } from "./chunker.js";
export { buildCanonicalColumnMap, matchNormalizedRow } from "./matcher.js";
export { ensurePetition, upsertPetitionSignature } from "./petitions.js";
export {
  insertSignatureEvent,
  recordSignatureEventFailureOnMatch,
  insertImportMatchReview,
} from "./audit.js";
export type { SignatureEventType, ImportReviewAction } from "./audit.js";
export {
  columnExists,
  tableExists,
  viewExists,
  fetchReviewQueue,
  fetchBatchSummary,
  exportReviewQueueCsv,
  parseCsvStatuses,
  DEFAULT_REVIEW_QUEUE_STATUSES,
  runApproveRow,
  runRejectRow,
  runNeedsMoreInfo,
  runAddReviewNote,
  runReviewProgress,
  runReviewNextUnderThreshold,
  runMoreReviewCandidates,
  runSelectReviewCandidate,
  runPlaceNonvoter,
  runNonvoterReport,
} from "./review.js";
export type { ReviewQueueRow, BatchSummaryJson } from "./review.js";
export {
  loadBatchSignatureReportRows,
  loadPetitionReportRows,
  writeBatchOperatorReport,
  writePetitionOperatorReport,
} from "./reporting.js";
export type { BatchSignatureReportRow, BatchReportSummaryJson, PetitionReportSummaryJson } from "./reporting.js";
export { fetchNextReviewRow, searchVotersForRow, fetchGeoForApprove } from "./reviewSearch.js";
export type { VoterSearchCandidate } from "./reviewSearch.js";
export {
  isSlamDunkMatch,
  rowNeedsReviewByOutcome,
  rowNeedsOperatorQueue,
  parseQaFlagsJson,
  problemTagsForRow,
  recommendedActionForProblem,
} from "./matchQuality.js";
export {
  writeLocalReportFiles,
  insertSummaryReport,
  aggregateCityCounty,
  aggregateByChunk,
  countMatchStatuses,
  tryAppendReviewStatsToSummary,
  csvFromRows,
  csvFromQaRows,
  defaultImportPlanOutPath,
} from "./reports.js";
export { runPreflightOnSheet } from "./preflight.js";
export {
  stableDuplicateKey,
  applyWithinFileDuplicateFlags,
  processMappedRow,
  buildQaFlagsCsvRow,
  qaFlagsToString,
} from "./rowPipeline.js";
export {
  readMatchSourceTableEnv,
  resolveMatchSourceTable,
  getMatchSourceMode,
  resolveMatchQueryQualifiedTable,
  getStandardMatchColumns,
  buildMatchSourceWhereClauses,
  validateMatchSourceColumns,
  safeColumnPresenceReport,
  inspectVoterMatchSource,
  relationExists,
  matchPetitionMailOnMatchSource,
  assertVoterExistsInMatchSourceOrCanonical,
  fetchVoterGeoForVoterId,
  fetchVoterLocationSnapshot,
  computeProjectedMatchingQuality,
  evaluateMatchReadiness,
  evaluateCandidateProbe,
} from "./matchSource.js";
export type { VoterGeoSnapshot, VoterLocationSnapshot } from "./matchSource.js";
export type { MatchReadinessResult } from "./matchSource.js";
export { computeFileSha256, getFileSizeBytes, shortHash } from "./fileHash.js";
export { runFullImport } from "./importRunner.js";
export {
  calculateMatchConfidencePct,
  manualApprovalConfidencePct,
  buildConfidenceReason,
  searchPriorityFromConfidence,
} from "./confidence.js";
export {
  upsertInitiative,
  fetchInitiativeByCode,
  listInitiatives,
  getInitiativeSummary,
  validateInitiativeExecutionGuards,
} from "./initiatives.js";
export {
  derivePlanKey,
  computeImportPlanBlocking,
  computeImportPlanDecision,
  prepareImportPlan,
  readImportPlan,
  reviewImportPlan,
  validatePlanForExecution,
  updatePlanAfterExecution,
  saveImportPlanToDb,
  listImportPlansFromDb,
  inspectImportPlanSummary,
  executeImportPlanFromDisk,
  importPlansTableExists,
} from "./importPlan.js";
export { discoverVoterSchema, fetchTableColumnsMetadata, classifyColumnName, listPublicTables } from "./schemaDiscovery.js";
export {
  evaluateJurisdictionStatus,
  evaluateSignerJurisdictionStatus,
  zip5Equal,
} from "./jurisdiction.js";
export type { JurisdictionPetitionContext, JurisdictionLocationInput, JurisdictionStatusResult } from "./jurisdiction.js";
export { rankCandidatesForRow } from "./candidateRanking.js";
export type { RankedCandidate } from "./candidateRanking.js";
export {
  initiativeReviewQueue80ViewExists,
  fetchNextInitiativeReviewQueue80,
  jurisdictionContextFromQueueRow,
  buildRankedReviewCandidates,
  replaceReviewCandidateSnapshots,
  fetchSnapshotsForRowPage,
} from "./reviewQueue80.js";
export type { InitiativeReviewQueue80Row } from "./reviewQueue80.js";
export { insertInitiativeNonvoterEntry, fetchNonvoterEntriesForPetition } from "./nonvoters.js";
export type { NonvoterReason, NonvoterReportRow } from "./nonvoters.js";
export { buildMatchSourcePlan, planFromDiscovery } from "./matchSourcePlanner.js";
export {
  emitMatchSourceViewSql,
  validatePlanSqlFragment,
  assertSafeMatchSourceViewSql,
  stripSqlComments,
  loadMatchSourcePlan,
  readSqlFile,
} from "./sqlEmitter.js";
export {
  normalizeWhitespace,
  normalizeName,
  normalizeCity,
  normalizeCounty,
  normalizeState,
  normalizeStateUpper,
  normalizeZip5,
  normalizeAddressKey,
  parseBirthYear,
  parseBirthMonth,
  parseBirthDay,
  parseBirthYearStrict,
  parseIsoDateOnly,
  excelSerialToIsoDate,
  parseSignedAtCell,
  treatAsEmpty,
  isoDateFromParts,
  applySourceProfileNormalization,
  ensureQaFlagsArray,
  toTitleCaseFromLower,
  normalizeExternalId,
} from "./normalize.js";
