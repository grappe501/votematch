import { writeFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import type { BatchReportSummaryJson, BatchSignatureReportRow } from "./reporting.js";

type WardRow = {
  ward: string;
  total_matched: number;
  slam_dunk: number;
  manually_approved: number;
  needs_review_matched: number;
  avg_confidence_pct?: string;
  slam_dunk_100_count?: number;
  needs_review_count?: number;
  percent_of_matched: string;
};

type CountyRow = {
  county: string;
  total_matched: number;
  slam_dunk_100: number;
  manually_approved: number;
  needs_review_matched: number;
  avg_confidence_pct: string;
  percent_of_matched: string;
};

type ProblemRow = {
  problem: string;
  count: number;
  percent_of_total: string;
  example_row_numbers: string;
  recommended_action: string;
  bucket_100?: number;
  bucket_90_99?: number;
  bucket_75_89?: number;
  bucket_50_74?: number;
  bucket_1_49?: number;
  bucket_0?: number;
  bucket_unknown?: number;
};

type QaWorkbookRow = {
  row_number: number;
  qa_flags: string;
  first_name_present: boolean;
  last_name_present: boolean;
  address_present: boolean;
  city: string;
  state: string;
  zip: string;
  signed_at: string;
  notes_present: boolean;
  match_status: string;
  review_status: string;
  voter_id: string;
  match_confidence_pct?: number;
};

export async function writeReportWorkbook(
  outPath: string,
  data: {
    summary: BatchReportSummaryJson;
    slamRows: BatchSignatureReportRow[];
    reviewCsvRows: BatchSignatureReportRow[];
    wardRows: WardRow[];
    countyRows?: CountyRow[];
    problemRows: ProblemRow[];
    qaRows: QaWorkbookRow[];
    confidenceDistribution?: { bucket: string; count: number }[];
  }
): Promise<void> {
  const wb = XLSX.utils.book_new();

  const summarySheet = XLSX.utils.json_to_sheet([data.summary as unknown as Record<string, unknown>]);
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  const slamSheet = XLSX.utils.json_to_sheet(
    data.slamRows.map((r) => ({
      row_number: r.row_number,
      voter_id: r.voter_id ?? "",
      first_name: r.signer_first_name ?? "",
      last_name: r.signer_last_name ?? "",
      city: r.signer_city ?? "",
      zip: r.signer_zip ?? "",
      ward: r.signature_voter_ward ?? "",
      precinct: r.signature_voter_precinct ?? "",
      match_method: r.match_method ?? "",
      match_confidence: r.match_confidence ?? "",
      match_confidence_pct: r.match_confidence_pct ?? "",
      signed_at: r.signed_at ?? "",
    }))
  );
  XLSX.utils.book_append_sheet(wb, slamSheet, "Matched Slam Dunk");

  const reviewSheet = XLSX.utils.json_to_sheet(
    data.reviewCsvRows.map((r) => ({
      row_number: r.row_number,
      review_status: r.review_status,
      match_status: r.match_status,
      first_name: r.signer_first_name ?? "",
      last_name: r.signer_last_name ?? "",
      city: r.signer_city ?? "",
      zip: r.signer_zip ?? "",
      match_confidence_pct: r.match_confidence_pct ?? "",
      signed_at: r.signed_at ?? "",
    }))
  );
  XLSX.utils.book_append_sheet(wb, reviewSheet, "Do Not Match Review");

  const wardSheet = XLSX.utils.json_to_sheet(data.wardRows);
  XLSX.utils.book_append_sheet(wb, wardSheet, "Matched By Ward");

  if (data.countyRows && data.countyRows.length > 0) {
    const countySheet = XLSX.utils.json_to_sheet(data.countyRows);
    XLSX.utils.book_append_sheet(wb, countySheet, "Matched By County");
  }

  const probSheet = XLSX.utils.json_to_sheet(data.problemRows);
  XLSX.utils.book_append_sheet(wb, probSheet, "Biggest Problems");

  const qaSheet = XLSX.utils.json_to_sheet(data.qaRows);
  XLSX.utils.book_append_sheet(wb, qaSheet, "QA Flags");

  if (data.confidenceDistribution && data.confidenceDistribution.length > 0) {
    const distSheet = XLSX.utils.json_to_sheet(data.confidenceDistribution);
    XLSX.utils.book_append_sheet(wb, distSheet, "Confidence Distribution");
  }

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
  await writeFile(outPath, buf);
}
