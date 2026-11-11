import type {
  ReadMarkAmendmentDto,
  ReadMarkDocumentDto,
  ReadMarksDto,
  ReadState,
} from "../types/api";

/**
 * Read marks (docs/design.md, "Read marks"): an account marks by hand the
 * published documents and amendments it has read, and the platform says
 * which ones are left and which changed since. Pure rules, shared by the
 * server (the state of each mark) and the pages (what is left, in order).
 */

/** The state of a mark: `marked` is the revision the account read, if any. */
export function readStateOf(
  marked: string | null | undefined,
  current: string,
): ReadState {
  if (marked === null || marked === undefined) return "unread";
  return marked === current ? "read" : "changed";
}

/** Left to read: not the account's own, and not read as it is now. */
export function isDocumentLeft(mark: ReadMarkDocumentDto): boolean {
  return !mark.own && mark.state !== "read";
}

/** Left to read: as a document, and still to be debated. */
export function isAmendmentLeft(mark: ReadMarkAmendmentDto): boolean {
  return !mark.own && mark.open && mark.state !== "read";
}

export interface ReadMarkIndex {
  documents: ReadonlyMap<string, ReadMarkDocumentDto>;
  amendments: ReadonlyMap<string, ReadMarkAmendmentDto>;
  /** Amendments left to read, by document. */
  amendmentsLeft: ReadonlyMap<string, number>;
}

export function indexReadMarks(marks: ReadMarksDto | null): ReadMarkIndex {
  const amendmentsLeft = new Map<string, number>();
  for (const mark of marks?.amendments ?? []) {
    if (!isAmendmentLeft(mark)) continue;
    amendmentsLeft.set(
      mark.documentId,
      (amendmentsLeft.get(mark.documentId) ?? 0) + 1,
    );
  }
  return {
    documents: new Map((marks?.documents ?? []).map((mark) => [mark.id, mark])),
    amendments: new Map(
      (marks?.amendments ?? []).map((mark) => [mark.id, mark]),
    ),
    amendmentsLeft,
  };
}

export interface ReadProgress {
  /** Documents that count: published, not the account's own. */
  documents: number;
  documentsLeft: number;
  /** Amendments that count: published, open, not the account's own. */
  amendments: number;
  amendmentsLeft: number;
}

export function readProgress(marks: ReadMarksDto | null): ReadProgress {
  const documents = (marks?.documents ?? []).filter((mark) => !mark.own);
  const amendments = (marks?.amendments ?? []).filter(
    (mark) => !mark.own && mark.open,
  );
  return {
    documents: documents.length,
    documentsLeft: documents.filter(isDocumentLeft).length,
    amendments: amendments.length,
    amendmentsLeft: amendments.filter(isAmendmentLeft).length,
  };
}

/** Whether a document has something left: itself, or amendments to it. */
export function hasSomethingLeft(index: ReadMarkIndex, id: string): boolean {
  const mark = index.documents.get(id);
  return (
    (mark !== undefined && isDocumentLeft(mark)) ||
    (index.amendmentsLeft.get(id) ?? 0) > 0
  );
}

export interface ReadNeighbours<T> {
  /** Position among `ordered`, from 0; -1 when it is not there. */
  index: number;
  total: number;
  previous: T | null;
  next: T | null;
  /**
   * The next one with something left, after this one and going round to the
   * start; null when nothing else is left.
   */
  nextLeft: T | null;
}

/**
 * Where a document sits among the documents in reading order (the agenda's),
 * with the ones before and after it and the next one with something left.
 */
export function readNeighbours<T extends { id: string }>(
  ordered: readonly T[],
  id: string | null,
  index: ReadMarkIndex,
): ReadNeighbours<T> {
  const position = id === null ? -1 : ordered.findIndex((d) => d.id === id);
  const rest =
    position < 0
      ? [...ordered]
      : [...ordered.slice(position + 1), ...ordered.slice(0, position)];
  return {
    index: position,
    total: ordered.length,
    previous: position > 0 ? (ordered[position - 1] ?? null) : null,
    next: position >= 0 ? (ordered[position + 1] ?? null) : null,
    nextLeft: rest.find((d) => hasSomethingLeft(index, d.id)) ?? null,
  };
}
