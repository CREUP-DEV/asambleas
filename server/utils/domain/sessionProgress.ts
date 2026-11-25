import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { AssemblyStatus } from "~~/shared/constants/domain";
import type { SessionProgressDto } from "~~/shared/types/api";
import {
  itemsAwaitingVote,
  itemsPresentedTreated,
  sessionTreatedItems,
  type PresentedTarget,
} from "~~/shared/utils/sessionProgress";
import { db } from "../../db";
import {
  agendaItems,
  amendments,
  controlSheetItems,
  documents,
  liveState,
  votes,
} from "../../db/schema";
import type { Actor } from "./actor";
import { titleDocumentPayload } from "./agendaWrites";
import { recordEvent, type Executor } from "./events";
import { keepUpdatedAt } from "../optimisticLock";
import { loadItemVoteRows } from "./votes";

/**
 * How far the session has gone, as the Mesa's console marks it (user's
 * decisions of 2026-11-18 and 2026-11-19):
 *
 * - a document is «Proyectado» once the Mesa first puts it on screen during
 *   the session (`documents.first_projected_at`, never cleared);
 * - what the Mesa presents in session (the live state moves to an agenda
 *   item, or to a document, whose own item it is) becomes treated in the
 *   control sheet at once (`itemsPresentedTreated`): the Mesa's «Tratado»,
 *   set as if the Mesa had ticked it (`control_sheet_treated_changed` with
 *   `byDebate`), and unticked from the sheet or the console like any other.
 *   Only what is presented, never the items above it; what still waits for
 *   a vote (a voted document without its final vote, an item marked «Se vota
 *   el punto» without its vote, and the items above them) is left alone: it
 *   is treated once voted. A mark the Mesa took away comes back only when
 *   the item is presented again.
 *
 * Both run inside the transaction of the live_state writer
 * (applyOnScreenMarks): updateLiveState and the status change hold the
 * assembly row NO KEY UPDATE, so the sheet's writes (FOR SHARE first) wait;
 * a vote that moves the projection holds it FOR SHARE, and the sheet's
 * writes then wait on the control_sheet_items row, which they lock without
 * taking any lock the vote holds.
 */

/**
 * Stamps the first time a document goes on screen in session. Its
 * `updatedAt` stays: the stamp is in no DTO and only `live_changed` (no
 * document event) goes with it, so a moved `updatedAt` would make the next
 * edit of a form open on the document fail as stale (409).
 */
export async function stampProjected(
  tx: Executor,
  documentId: string,
): Promise<void> {
  await tx
    .update(documents)
    .set({
      firstProjectedAt: sql`now()`,
      updatedAt: keepUpdatedAt(documents.updatedAt),
    })
    .where(
      and(eq(documents.id, documentId), isNull(documents.firstProjectedAt)),
    );
}

/**
 * Stamps the first time amendments go on screen in session, alone or in a
 * bloc (user's decision of 2026-11-21): the control sheet reads a pending
 * amendment treated once projected. As for documents, `updatedAt` stays,
 * so no open form goes stale.
 */
export async function stampAmendmentsProjected(
  tx: Executor,
  amendmentIds: readonly (string | null | undefined)[],
): Promise<void> {
  const ids = [
    ...new Set(amendmentIds.filter((id): id is string => Boolean(id))),
  ];
  if (ids.length === 0) return;
  await tx
    .update(amendments)
    .set({
      firstProjectedAt: sql`now()`,
      updatedAt: keepUpdatedAt(amendments.updatedAt),
    })
    .where(
      and(inArray(amendments.id, ids), isNull(amendments.firstProjectedAt)),
    );
}

/** What the live state points at, as the marks of putting it on screen read it. */
export type OnScreen = {
  agendaItemId: string | null;
  documentId: string | null;
  amendmentId: string | null;
  amendmentBloc: readonly string[] | null;
};

/**
 * What putting `next` on screen marks, by every writer that moves the
 * projection (the PUT, a vote that moves it, the session opening with
 * something on screen; not repointSession): only in session, the document that comes on screen
 * (stampProjected), the amendments on screen alone or in a bloc
 * (stampAmendmentsProjected), and, when the item or the document changes,
 * what it presents (`presented`, markPresentedTreated). `previous` null is
 * the session opening with `next` already on screen.
 */
export function onScreenMarks(
  status: AssemblyStatus | null | undefined,
  previous: OnScreen | null,
  next: OnScreen,
): { documentId: string | null; amendmentIds: string[]; presented: boolean } {
  if (status !== "in_session") {
    return { documentId: null, amendmentIds: [], presented: false };
  }
  const moved =
    !previous ||
    next.agendaItemId !== previous.agendaItemId ||
    next.documentId !== previous.documentId;
  return {
    documentId:
      next.documentId && next.documentId !== previous?.documentId
        ? next.documentId
        : null,
    amendmentIds: [
      ...new Set(
        [next.amendmentId, ...(next.amendmentBloc ?? [])].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ],
    presented: moved && Boolean(next.agendaItemId || next.documentId),
  };
}

/**
 * Applies onScreenMarks inside the writer's transaction, after its locks
 * ("Row locks" in documents.ts). Where the writer holds the document only
 * FOR SHARE (an amendment vote), stamping it upgrades that lock, as
 * stampDebateStarted already does at the same moment, and only the first
 * time the document goes on screen.
 */
export async function applyOnScreenMarks(
  tx: Executor,
  input: {
    assemblyId: string;
    status: AssemblyStatus | null | undefined;
    previous: OnScreen | null;
    next: OnScreen;
    actor: Actor;
  },
): Promise<void> {
  const marks = onScreenMarks(input.status, input.previous, input.next);
  if (marks.documentId) await stampProjected(tx, marks.documentId);
  await stampAmendmentsProjected(tx, marks.amendmentIds);
  if (marks.presented) {
    await markPresentedTreated(tx, {
      assemblyId: input.assemblyId,
      previous: input.previous,
      next: input.next,
      actor: input.actor,
    });
  }
}

type AgendaItemRow = typeof agendaItems.$inferSelect;
type ProgressDocumentRow = {
  id: string;
  agendaItemId: string;
  voted: boolean;
  status: (typeof documents.$inferSelect)["status"];
  finalVoteId: string | null;
};

/**
 * The assembly's agenda items, its documents and the items that still
 * wait for a vote (itemsAwaitingVote, over the whole agenda): what the
 * marks set by presenting and by hand are checked against.
 */
export async function loadAwaitingVote(
  executor: Executor,
  assemblyId: string,
): Promise<{
  items: AgendaItemRow[];
  documents: ProgressDocumentRow[];
  awaiting: Set<string>;
}> {
  const [items, documentRows, itemVotes] = await Promise.all([
    executor
      .select()
      .from(agendaItems)
      .where(eq(agendaItems.assemblyId, assemblyId)),
    executor
      .select({
        id: documents.id,
        agendaItemId: documents.agendaItemId,
        voted: documents.voted,
        status: documents.status,
        finalVoteId: documents.finalVoteId,
      })
      .from(documents)
      .where(eq(documents.assemblyId, assemblyId)),
    executor
      .select({ subjectId: votes.subjectId })
      .from(votes)
      .where(
        and(
          eq(votes.assemblyId, assemblyId),
          eq(votes.subjectType, "agenda_item"),
          isNull(votes.voidedAt),
        ),
      ),
  ]);
  const awaiting = itemsAwaitingVote(
    items,
    documentRows,
    new Set(itemVotes.map((vote) => vote.subjectId)),
  );
  return { items, documents: documentRows, awaiting };
}

/**
 * Sets the Mesa's mark on `ids`, as if the Mesa had ticked them (byDebate):
 * only rows not marked yet, each with its event.
 */
async function markItemsTreated(
  tx: Executor,
  input: {
    assemblyId: string;
    ids: string[];
    items: readonly AgendaItemRow[];
    actor: Actor;
  },
): Promise<void> {
  const { ids } = input;
  if (ids.length === 0) return;
  const byId = new Map(input.items.map((item) => [item.id, item]));

  await tx
    .insert(controlSheetItems)
    .values(
      ids.map((agendaItemId) => ({
        assemblyId: input.assemblyId,
        agendaItemId,
      })),
    )
    .onConflictDoNothing({ target: controlSheetItems.agendaItemId });
  const rows = await tx
    .select({
      id: controlSheetItems.id,
      agendaItemId: controlSheetItems.agendaItemId,
    })
    .from(controlSheetItems)
    .where(
      and(
        inArray(controlSheetItems.agendaItemId, ids),
        isNull(controlSheetItems.treatedAt),
      ),
    )
    .orderBy(controlSheetItems.id)
    .for("no key update");
  if (rows.length === 0) return;

  const now = new Date();
  await tx
    .update(controlSheetItems)
    .set({
      treatedAt: now,
      treatedByUserId: input.actor.user.id,
      progressUpdatedAt: now,
    })
    .where(
      inArray(
        controlSheetItems.id,
        rows.map((row) => row.id),
      ),
    );
  for (const row of rows) {
    const item = byId.get(row.agendaItemId)!;
    await recordEvent(tx, {
      assemblyId: input.assemblyId,
      entityType: "control_sheet",
      entityId: row.id,
      type: "control_sheet_treated_changed",
      payload: {
        subjectType: "agenda_item",
        subjectId: item.id,
        ...titleDocumentPayload(item),
        treated: true,
        byDebate: true,
      },
      actor: input.actor,
    });
  }
}

/** The live state's agenda item and the item of its document. */
function presentedTarget(
  state: { agendaItemId: string | null; documentId: string | null },
  documentRows: readonly ProgressDocumentRow[],
): PresentedTarget {
  const document = state.documentId
    ? documentRows.find((row) => row.id === state.documentId)
    : undefined;
  return {
    agendaItemId: state.agendaItemId,
    documentItemId: document?.agendaItemId ?? null,
  };
}

/**
 * Marks treated what the live state presents now and did not before
 * (itemsPresentedTreated of `next` minus that of `previous`): taking a
 * document off or moving between amendments never marks again an item the
 * Mesa has just unticked. `previous` null marks everything presented (the
 * session opening with something on screen).
 */
export async function markPresentedTreated(
  tx: Executor,
  input: {
    assemblyId: string;
    previous: { agendaItemId: string | null; documentId: string | null } | null;
    next: { agendaItemId: string | null; documentId: string | null };
    actor: Actor;
  },
): Promise<void> {
  if (!input.next.agendaItemId && !input.next.documentId) return;
  const {
    items,
    documents: documentRows,
    awaiting,
  } = await loadAwaitingVote(tx, input.assemblyId);
  const before = new Set(
    input.previous
      ? itemsPresentedTreated(
          items,
          presentedTarget(input.previous, documentRows),
        )
      : [],
  );
  const ids = itemsPresentedTreated(
    items,
    presentedTarget(input.next, documentRows),
    awaiting,
  ).filter((id) => !before.has(id));
  await markItemsTreated(tx, {
    assemblyId: input.assemblyId,
    ids,
    items,
    actor: input.actor,
  });
}

/**
 * The session opens (or resumes) with something already on screen: it is
 * presented from now on, so it is marked as on any move (user's decision of
 * 2026-11-19). Runs in the status change's transaction.
 */
export async function markOnScreenAtOpen(
  tx: Executor,
  assemblyId: string,
  actor: Actor,
): Promise<void> {
  const [state] = await tx
    .select({
      agendaItemId: liveState.agendaItemId,
      documentId: liveState.documentId,
      amendmentId: liveState.amendmentId,
      amendmentBloc: liveState.amendmentBloc,
    })
    .from(liveState)
    .where(eq(liveState.assemblyId, assemblyId));
  if (!state) return;
  await applyOnScreenMarks(tx, {
    assemblyId,
    status: "in_session",
    previous: null,
    next: state,
    actor,
  });
}

/**
 * GET .../session-progress (session:moderate): the documents projected
 * and where every agenda item stands (sessionTreatedItems, the control
 * sheet's rule), with the mark's token so the console can undo or set it
 * again. Ids and flags only: the console has the items and documents.
 */
export async function loadSessionProgress(
  assemblyId: string,
): Promise<SessionProgressDto> {
  const [projected, marks, items, documentRows, itemVoteRows] =
    await Promise.all([
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.assemblyId, assemblyId),
            isNotNull(documents.firstProjectedAt),
          ),
        ),
      db
        .select({
          agendaItemId: controlSheetItems.agendaItemId,
          treatedAt: controlSheetItems.treatedAt,
          manualResult: controlSheetItems.manualResult,
          progressUpdatedAt: controlSheetItems.progressUpdatedAt,
        })
        .from(controlSheetItems)
        .where(eq(controlSheetItems.assemblyId, assemblyId)),
      db
        .select({
          id: agendaItems.id,
          parentId: agendaItems.parentId,
          generatedForDocumentId: agendaItems.generatedForDocumentId,
          voted: agendaItems.voted,
        })
        .from(agendaItems)
        .where(eq(agendaItems.assemblyId, assemblyId)),
      db
        .select({
          id: documents.id,
          agendaItemId: documents.agendaItemId,
          voted: documents.voted,
          status: documents.status,
          finalVoteId: documents.finalVoteId,
        })
        .from(documents)
        .where(eq(documents.assemblyId, assemblyId)),
      loadItemVoteRows(assemblyId),
    ]);
  const finalVoteIds = documentRows
    .map((row) => row.finalVoteId)
    .filter((id): id is string => id !== null);
  const finalVotes =
    finalVoteIds.length > 0
      ? await db.select().from(votes).where(inArray(votes.id, finalVoteIds))
      : [];
  const finalVoteById = new Map(finalVotes.map((vote) => [vote.id, vote]));
  const treatments = sessionTreatedItems(
    items,
    documentRows.map((row) => {
      const vote = row.finalVoteId ? finalVoteById.get(row.finalVoteId) : null;
      return { ...row, finalVote: vote ? sheetVote(vote) : null };
    }),
    itemVoteRows.map((vote) => ({
      ...sheetVote(vote),
      id: vote.id,
      subjectId: vote.subjectId,
      recordedAt: vote.recordedAt.toISOString(),
      voidedAt: vote.voidedAt?.toISOString() ?? null,
    })),
    marks.map((mark) => ({
      agendaItemId: mark.agendaItemId,
      treated: mark.treatedAt !== null,
      manualResult: mark.manualResult,
      token: mark.progressUpdatedAt?.toISOString() ?? null,
    })),
  );
  return {
    projectedDocumentIds: projected.map((row) => row.id).sort(),
    items: treatments.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** What the sheet's rule reads of a vote row. */
function sheetVote(vote: typeof votes.$inferSelect) {
  return {
    method: vote.method,
    result: vote.result,
    inFavor: vote.inFavor,
    against: vote.against,
    abstentions: vote.abstentions,
    blank: vote.blank,
    invalid: vote.invalid,
    unanimous: vote.unanimous,
  };
}
