import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import * as XLSX from "xlsx";
import { parse } from "csv-parse/sync";
import type { ParsedSheet } from "./types.js";

export type ParseFileOptions = {
  /** Excel sheet name; defaults to first sheet when unset. */
  sheetName?: string;
  /** 1-based header row index (default 1). */
  headerRow?: number;
  /** 1-based first data row index (default: headerRow + 1). */
  dataStartRow?: number;
};

function normalizeCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return String(v).trim();
}

function trimTrailingEmptyRows(rows: string[][]): string[][] {
  let end = rows.length;
  while (end > 0) {
    const row = rows[end - 1]!;
    if (row.some((c) => normalizeCell(c) !== "")) break;
    end -= 1;
  }
  return rows.slice(0, end);
}

function parseCsvBuffer(buf: Buffer): ParsedSheet {
  const text = buf.toString("utf8");
  const records = parse(text, {
    bom: true,
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as string[][];
  if (records.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = records[0]!.map((h) => normalizeCell(h));
  const rows = records.slice(1).map((r) => headers.map((_, i) => normalizeCell(r[i])));
  return { headers, rows: trimTrailingEmptyRows(rows) };
}

function parseXlsxBuffer(buf: Buffer, opts?: ParseFileOptions): ParsedSheet {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const headerRow1 = opts?.headerRow && opts.headerRow > 0 ? opts.headerRow : 1;
  const dataStart1 =
    opts?.dataStartRow && opts.dataStartRow > headerRow1 ? opts.dataStartRow : headerRow1 + 1;

  const requested = opts?.sheetName?.trim();
  let sheetName = wb.SheetNames[0] ?? "";
  if (requested) {
    if (!wb.SheetNames.includes(requested)) {
      throw new Error(
        `Workbook has no sheet named "${requested}". Available sheets: ${wb.SheetNames.join(", ")}`
      );
    }
    sheetName = requested;
  }

  if (!sheetName) {
    return { headers: [], rows: [] };
  }
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    return { headers: [], rows: [] };
  }
  const aoa = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  }) as unknown[][];
  if (aoa.length === 0) {
    return { headers: [], rows: [] };
  }

  const headerIdx = headerRow1 - 1;
  const headerRow = (aoa[headerIdx] ?? []) as unknown[];
  const headers = headerRow.map((c) => normalizeCell(c));

  const dataStartIdx = dataStart1 - 1;
  const rawRows = aoa.slice(dataStartIdx) as unknown[][];
  const rows = rawRows.map((r) => headers.map((_, i) => normalizeCell((r as unknown[])[i])));

  return { headers, rows: trimTrailingEmptyRows(rows) };
}

export function parseVoterBuffer(buf: Buffer, filePath: string, opts?: ParseFileOptions): ParsedSheet {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".csv" || ext === ".txt") {
    return parseCsvBuffer(buf);
  }
  if (ext === ".xlsx" || ext === ".xls") {
    return parseXlsxBuffer(buf, opts);
  }
  throw new Error(`Unsupported file extension "${ext}" (use .csv, .txt, .xlsx, or .xls)`);
}

export async function parseVoterFile(filePath: string, opts?: ParseFileOptions): Promise<ParsedSheet> {
  const buf = await readFile(filePath);
  return parseVoterBuffer(buf, filePath, opts);
}
