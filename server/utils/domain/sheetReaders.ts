import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
} from "drizzle-orm";
import { db } from "../../db";
import { amendmentNotes, amendments, documentNotes } from "../../db/schema";
import type {
  AcceptedAmendmentRule,
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  AdmissionStatus,
  AcceptanceDecision,
  AcceptanceRole,
  ProponentPosition,
} from "~~/shared/constants/domain";
import type {
  AmendmentNoteDto,
  ControlSheetNotesDto,
  DocumentNoteDto,
} from "~~/shared/types/api";
import type { Actor } from "./actor";
import { canSeeLoadedAmendment, findAmendmentsByIds } from "./amendments";
import { loadAnswersOnValidation } from "./executiveMembers";
import { authorsApproval, positionBlocker } from "./reviewState";
import { isDocumentPresenter, type DocumentPresenters } from "./visibility";

/**
 * What the control sheet gives a reader of its own, beside what everyone
 * reads (user's decisions of 2026-11-21): «Mis notas», the account's
 * general private notes on the documents and amendments the sheet shows it,
 * and, for whoever presents a document, how many of its amendments wait for
 * the presenters' answer («Mis documentos»).
 *
 * The notes are the account's own, as everywhere (documentNotes.ts,
 * amendmentNotes.ts): every query here is keyed by `actor.user.id`, never
 * by member, so other accounts of the same council never read them. They
 * travel only in their own answer (GET .../control-sheet/notes), never in
 * ControlSheetDto, a live message, an event or the audit.
 */

// «Mis documentos» -----------------------------------------------------------

/** What deciding whether an amendment waits for an answer needs of it. */
export interface AwaitingAnswerRow {
  documentId: string;
  status: AmendmentStatus;
  admission: AdmissionStatus;
  validatedAt: Date | null;
  publishedAt: Date | null;
  approvalMethod: ApprovalMethod | null;
  kind: AmendmentKind;
  outcomeVoteId: string | null;
  acceptances: { role: AcceptanceRole; decision: AcceptanceDecision }[];
  position: { position: ProponentPosition } | null;
}

/** What it needs of each document the reader presents. */
export interface AwaitingAnswerDocument {
  acceptedAmendments: AcceptedAmendmentRule;
  /** Its final vote is recorded (documentVoted): nothing is answered. */
  voted: boolean;
  /** The main presenter answers once validated (answersOnValidation). */
  presenterSeesValidated: boolean;
}

/**
 * How many of `rows` wait for the presenters' answer, by document, over
 * the documents the reader presents (`presented`): presented and
 * undecided, still without an answer, and with nothing holding the answer
 * back (positionBlocker, the rule `can.position` reads). An amendment the
 * assembly already approved can still be answered, but never waits for it.
 * `rows` are those the reader sees (visibleSheetAmendments).
 */
export function awaitingAnswerCounts(
  rows: readonly AwaitingAnswerRow[],
  presented: ReadonlyMap<string, AwaitingAnswerDocument>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const document = presented.get(row.documentId);
    if (!document || row.status !== "submitted") continue;
    if ((row.position?.position ?? "pending") !== "pending") continue;
    const blocker = positionBlocker(
      {
        ...row,
        authorsApproval: authorsApproval(row),
        presenterSeesValidated: document.presenterSeesValidated,
      },
      document.acceptedAmendments,
      document.voted,
    );
    if (blocker !== null) continue;
    counts.set(row.documentId, (counts.get(row.documentId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The documents the actor presents among `documents`, with what
 * awaitingAnswerCounts needs of each (one read per document for whether
 * its main presenter answers on validation, only for those).
 */
export async function loadPresentedDocuments(
  actor: Actor,
  documents: readonly {
    id: string;
    proponentMemberId: string | null;
    coProponentMemberIds: readonly string[];
    acceptedAmendments: AcceptedAmendmentRule;
    finalVoteId: string | null;
    consolidatedVersionId: string | null;
  }[],
): Promise<Map<string, AwaitingAnswerDocument>> {
  const presented = documents.filter((document) =>
    isDocumentPresenter(actor, document),
  );
  const entries = await Promise.all(
    presented.map(
      async (document) =>
        [
          document.id,
          {
            acceptedAmendments: document.acceptedAmendments,
            voted: Boolean(
              document.finalVoteId || document.consolidatedVersionId,
            ),
            presenterSeesValidated: await loadAnswersOnValidation(document),
          },
        ] as const,
    ),
  );
  return new Map(entries);
}

// «Mis notas» ----------------------------------------------------------------

type DocumentNoteRow = typeof documentNotes.$inferSelect;
type AmendmentNoteRow = typeof amendmentNotes.$inferSelect;

function documentNoteDto(row: DocumentNoteRow): DocumentNoteDto {
  return {
    id: row.id,
    anchor: null,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function amendmentNoteDto(row: AmendmentNoteRow): AmendmentNoteDto {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The account's notes grouped as ControlSheetNotesDto says: only general
 * notes (no anchor) on the documents in `documentIds`, the anchored ones
 * there only counted, and the notes on the amendments in `amendmentIds`;
 * oldest first, as the rows come. Anything else is left out, whoever's it
 * is: the caller already keyed the rows by the account.
 */
export function groupSheetNotes(input: {
  documentRows: readonly DocumentNoteRow[];
  anchoredCounts: readonly { documentId: string; total: number }[];
  amendmentRows: readonly AmendmentNoteRow[];
  documentIds: ReadonlySet<string>;
  amendmentIds: ReadonlySet<string>;
}): ControlSheetNotesDto {
  const documents = new Map<
    string,
    { documentId: string; notes: DocumentNoteDto[]; anchored: number }
  >();
  const entry = (documentId: string) => {
    let found = documents.get(documentId);
    if (!found) {
      found = { documentId, notes: [], anchored: 0 };
      documents.set(documentId, found);
    }
    return found;
  };
  for (const row of input.documentRows) {
    if (row.blockId !== null || !input.documentIds.has(row.documentId)) {
      continue;
    }
    entry(row.documentId).notes.push(documentNoteDto(row));
  }
  for (const { documentId, total } of input.anchoredCounts) {
    if (total > 0 && input.documentIds.has(documentId)) {
      entry(documentId).anchored = total;
    }
  }
  const amendments = new Map<string, AmendmentNoteDto[]>();
  for (const row of input.amendmentRows) {
    if (!input.amendmentIds.has(row.amendmentId)) continue;
    const list = amendments.get(row.amendmentId) ?? [];
    list.push(amendmentNoteDto(row));
    amendments.set(row.amendmentId, list);
  }
  return {
    documents: [...documents.values()],
    amendments: [...amendments].map(([amendmentId, notes]) => ({
      amendmentId,
      notes,
    })),
  };
}

/**
 * GET .../control-sheet/notes: the account's general notes on the
 * published documents it sees and on the amendments past draft it sees
 * there (canSeeLoadedAmendment, as the sheet's own lists).
 * `visibleDocuments` are the assembly's documents the actor sees
 * (loadVisibleDocuments in controlSheet.ts).
 */
export async function loadControlSheetNotes(
  actor: Actor,
  visibleDocuments: readonly (DocumentPresenters & {
    id: string;
    status: string;
  })[],
): Promise<ControlSheetNotesDto> {
  const userId = actor.user.id;
  const documentById = new Map(
    visibleDocuments.map((document) => [document.id, document]),
  );
  const publishedIds = visibleDocuments
    .filter((document) => document.status === "published")
    .map((document) => document.id);
  const allIds = visibleDocuments.map((document) => document.id);
  if (allIds.length === 0) return { documents: [], amendments: [] };

  const [documentRows, anchoredCounts, ownAmendmentNotes] = await Promise.all([
    publishedIds.length > 0
      ? db
          .select()
          .from(documentNotes)
          .where(
            and(
              eq(documentNotes.userId, userId),
              inArray(documentNotes.documentId, publishedIds),
              isNull(documentNotes.blockId),
            ),
          )
          .orderBy(asc(documentNotes.createdAt), asc(documentNotes.id))
      : Promise.resolve([]),
    publishedIds.length > 0
      ? db
          .select({ documentId: documentNotes.documentId, total: count() })
          .from(documentNotes)
          .where(
            and(
              eq(documentNotes.userId, userId),
              inArray(documentNotes.documentId, publishedIds),
              isNotNull(documentNotes.blockId),
            ),
          )
          .groupBy(documentNotes.documentId)
      : Promise.resolve([]),
    // Only on the amendments of these documents (the assembly's).
    db
      .select(getTableColumns(amendmentNotes))
      .from(amendmentNotes)
      .innerJoin(amendments, eq(amendments.id, amendmentNotes.amendmentId))
      .where(
        and(
          eq(amendmentNotes.userId, userId),
          inArray(amendments.documentId, allIds),
        ),
      )
      .orderBy(asc(amendmentNotes.createdAt), asc(amendmentNotes.id)),
  ]);

  // Only the amendments the account wrote about are loaded, then judged as
  // the sheet judges them: of a document it sees, past draft, and readable.
  const noted = [...new Set(ownAmendmentNotes.map((row) => row.amendmentId))];
  const loaded = await findAmendmentsByIds(noted);
  const amendmentIds = new Set(
    loaded
      .filter((row) => {
        const document = documentById.get(row.documentId);
        return (
          row.status !== "draft" &&
          !!document &&
          canSeeLoadedAmendment(actor, row, document)
        );
      })
      .map((row) => row.id),
  );

  return groupSheetNotes({
    documentRows,
    anchoredCounts,
    amendmentRows: ownAmendmentNotes,
    documentIds: new Set(publishedIds),
    amendmentIds,
  });
}
