/**
 * The rows of "Añadir documentos": the list where the Secretaría writes
 * several documents for one agenda item (BulkDocumentsModal). Pure helpers:
 * which rows are sent, what is wrong with a row, and what the server said
 * about one.
 */

import type { DocumentFormat, DocumentKind } from "~~/shared/constants/domain";

export const BULK_TITLE_MAX = 300;
export const BULK_PDF_MAX_BYTES = 20 * 1024 * 1024;

/** What a row needs of a file: a `File` has all three. */
export interface BulkFile {
  name: string;
  type: string;
  size: number;
}

export interface BulkRow<F extends BulkFile = BulkFile> {
  /** Stable key of the row in the list. */
  key: number;
  title: string;
  kind: DocumentKind | undefined;
  /**
   * The member presenting it (the manager's own member by default); null
   * while none is chosen, which keeps the row from being sent.
   */
  proponentMemberId: string | null;
  format: DocumentFormat;
  /** The PDF to upload once the document exists (`file` format only). */
  file: F | null;
}

export interface BulkRowProblems {
  title?: "required" | "tooLong";
  kind?: "required";
  proponent?: "required";
  file?: "invalidType" | "tooLarge";
}

/** A row nobody wrote in: no title and no PDF. */
export function isBlankBulkRow(row: BulkRow): boolean {
  return row.title.trim() === "" && (row.format !== "file" || !row.file);
}

/**
 * The rows that become documents: every row but the blank ones, which are
 * lines left over at the end of the list. With nothing written anywhere the
 * first row stays, so its errors show.
 */
export function bulkRowsToSend<R extends BulkRow>(rows: readonly R[]): R[] {
  const written = rows.filter((row) => !isBlankBulkRow(row));
  const [first] = rows;
  return written.length > 0 || !first ? written : [first];
}

/** What is wrong with a PDF chosen for a row, if anything. */
export function bulkFileProblem(file: BulkFile): BulkRowProblems["file"] {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return "invalidType";
  if (file.size > BULK_PDF_MAX_BYTES) return "tooLarge";
  return undefined;
}

/** What keeps a row from being sent. Empty when it is fine. */
export function bulkRowProblems(row: BulkRow): BulkRowProblems {
  const problems: BulkRowProblems = {};
  const title = row.title.trim();
  if (!title) problems.title = "required";
  else if (title.length > BULK_TITLE_MAX) problems.title = "tooLong";
  if (!row.kind) problems.kind = "required";
  if (!row.proponentMemberId) problems.proponent = "required";
  const file = row.format === "file" && row.file ? row.file : null;
  const fileProblem = file ? bulkFileProblem(file) : undefined;
  if (fileProblem) problems.file = fileProblem;
  return problems;
}

/** A title proposed from a file name: "Resolución_becas.pdf" → "Resolución becas". */
export function titleFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, BULK_TITLE_MAX);
}

/**
 * The row a failed bulk request points at (`data.index`, in the order
 * sent), or null when the failure is not about one row. ofetch keeps the
 * response body in `data`, whose own `data` is what createError got.
 */
export function bulkErrorIndex(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as { data?: unknown }).data;
  if (!body || typeof body !== "object") return null;
  const nested = (body as { data?: unknown }).data;
  const data = (nested && typeof nested === "object" ? nested : body) as {
    index?: unknown;
  };
  return typeof data.index === "number" &&
    Number.isInteger(data.index) &&
    data.index >= 0
    ? data.index
    : null;
}
