/**
 * What the control sheet shows a reader of its own (user's decisions of
 * 2026-11-21): «Mis notas», the account's latest general private note on
 * each document or amendment (GET .../control-sheet/notes, never part of
 * the sheet's own answer), and which amendments wait for the reader's
 * answer as a presenter of their document. Pure, unit-tested
 * (-readers.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */

import type { ControlSheetNotesDto } from "~~/shared/types/api";
import type { AmendmentSheetRow, GeneralSheetRow } from "./-model";

/** A note as the sheet reads it: its text and when it was last written. */
export interface SheetNoteLike {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The note written last (its last edit counts as writing it): the latest
 * `updatedAt`, then `createdAt`, then the later one in the list. Null for
 * none.
 */
export function latestNote<T extends SheetNoteLike>(
  notes: readonly T[],
): T | null {
  let latest: T | null = null;
  for (const note of notes) {
    if (
      !latest ||
      note.updatedAt > latest.updatedAt ||
      (note.updatedAt === latest.updatedAt &&
        note.createdAt >= latest.createdAt)
    ) {
      latest = note;
    }
  }
  return latest;
}

/** One line of «Mis notas» in a row: a document's or an amendment's. */
export interface OwnNoteLine {
  /** The document it is on, on an item with several; null otherwise. */
  label: string | null;
  body: string;
  /** How many other general notes there are beside it («y N más»). */
  more: number;
}

/** The account's notes as the sheet looks them up, by id. */
export interface OwnSheetNotes {
  documents: ReadonlyMap<string, ControlSheetNotesDto["documents"][number]>;
  amendments: ReadonlyMap<string, ControlSheetNotesDto["amendments"][number]>;
}

export function indexOwnNotes(dto: ControlSheetNotesDto | null): OwnSheetNotes {
  return {
    documents: new Map(
      (dto?.documents ?? []).map((entry) => [entry.documentId, entry]),
    ),
    amendments: new Map(
      (dto?.amendments ?? []).map((entry) => [entry.amendmentId, entry]),
    ),
  };
}

/**
 * «Mis notas» of a row of «General»: the latest general note on each of
 * its documents that has one, in the row's order, named by the document's
 * title only when the item has more than one document.
 */
export function generalOwnNotes(
  row: Pick<GeneralSheetRow, "documents">,
  notes: OwnSheetNotes,
): OwnNoteLine[] {
  const several = row.documents.length > 1;
  return row.documents.flatMap((document) => {
    const entry = notes.documents.get(document.id);
    const latest = entry ? latestNote(entry.notes) : null;
    if (!entry || !latest) return [];
    return [
      {
        label: several ? document.title : null,
        body: latest.body,
        more: entry.notes.length - 1,
      },
    ];
  });
}

/** «Mis notas» of a row of «Enmiendas»: its latest note, if any. */
export function amendmentOwnNotes(
  amendmentId: string,
  notes: OwnSheetNotes,
): OwnNoteLine[] {
  const entry = notes.amendments.get(amendmentId);
  const latest = entry ? latestNote(entry.notes) : null;
  return entry && latest
    ? [{ label: null, body: latest.body, more: entry.notes.length - 1 }]
    : [];
}

/**
 * The amendment waits for the reader's answer: the reader presents its
 * document (ControlSheetDocumentDto.presenting), may answer it now
 * (`can.position`: nothing holds the answer back), and it is presented,
 * undecided and still unanswered, as the row shows it. The same rule as
 * the server's count (awaitingAnswerCounts in sheetReaders.ts), so the
 * filter «Por responder» lists what «N sin responder» counts. Never for
 * the Mesa answering for a document it does not present.
 */
export function awaitsPresenterAnswer(
  row: Pick<AmendmentSheetRow, "amendment" | "position">,
  presenting: boolean,
): boolean {
  return (
    presenting &&
    row.amendment.can.position &&
    row.amendment.status === "submitted" &&
    (row.position?.position ?? "pending") === "pending"
  );
}
