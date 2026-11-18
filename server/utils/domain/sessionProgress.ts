import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { SessionProgressDto } from "~~/shared/types/api";
import {
  itemsAwaitingVote,
  itemsLeftTreated,
} from "~~/shared/utils/sessionProgress";
import { db } from "../../db";
import {
  agendaItems,
  controlSheetItems,
  documents,
  votes,
} from "../../db/schema";
import type { Actor } from "./actor";
import { titleDocumentPayload } from "./agendaWrites";
import { recordEvent, type Executor } from "./events";

/**
 * How far the session has gone, as the Mesa's console marks it (user's
 * decision of 2026-11-18):
 *
 * - a document is «Proyectado» once the Mesa first puts it on screen during
 *   the session (`documents.first_projected_at`, never cleared);
 * - when the debate moves from one agenda item to another, the item left
 *   and its documents' automatic sub-items become treated in the control
 *   sheet (`itemsLeftTreated`): the Mesa's «Tratado», set as if the Mesa
 *   had ticked it (`control_sheet_treated_changed` with `byDebate`), and
 *   untick it there like any other. What still waits for a vote (a voted
 *   document without its final vote, an item marked «Se vota el punto»
 *   without its vote) is left alone: it is treated once voted.
 *
 * Both run inside updateLiveState's transaction, which holds the assembly
 * row FOR UPDATE: the sheet's writes take it FOR SHARE first, so they wait.
 */

/** Stamps the first time a document goes on screen in session. */
export async function stampProjected(
  tx: Executor,
  documentId: string,
): Promise<void> {
  await tx
    .update(documents)
    .set({ firstProjectedAt: sql`now()` })
    .where(
      and(eq(documents.id, documentId), isNull(documents.firstProjectedAt)),
    );
}

/**
 * Marks treated what the debate leaves behind going from `leftId` to
 * `nextId`. Only rows not treated yet: a mark the Mesa took away by hand
 * comes back only when the debate leaves that item again.
 */
export async function markLeftItemsTreated(
  tx: Executor,
  input: {
    assemblyId: string;
    leftId: string | null;
    nextId: string | null;
    actor: Actor;
  },
): Promise<void> {
  if (!input.leftId || !input.nextId || input.leftId === input.nextId) return;
  const [items, documentRows, itemVotes] = await Promise.all([
    tx
      .select()
      .from(agendaItems)
      .where(eq(agendaItems.assemblyId, input.assemblyId)),
    tx
      .select({
        id: documents.id,
        agendaItemId: documents.agendaItemId,
        voted: documents.voted,
        status: documents.status,
        finalVoteId: documents.finalVoteId,
      })
      .from(documents)
      .where(eq(documents.assemblyId, input.assemblyId)),
    tx
      .select({ subjectId: votes.subjectId })
      .from(votes)
      .where(
        and(
          eq(votes.assemblyId, input.assemblyId),
          eq(votes.subjectType, "agenda_item"),
          isNull(votes.voidedAt),
        ),
      ),
  ]);
  // Nothing that still waits for a vote is treated by moving on.
  const awaiting = itemsAwaitingVote(
    items,
    documentRows,
    new Set(itemVotes.map((vote) => vote.subjectId)),
  );
  const ids = itemsLeftTreated(items, input.leftId, input.nextId, awaiting);
  if (ids.length === 0) return;
  const byId = new Map(items.map((item) => [item.id, item]));

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

/**
 * GET .../session-progress (session:moderate): the documents projected
 * and the agenda items the Mesa's mark says are treated. Ids only: the
 * console has the items and documents already.
 */
export async function loadSessionProgress(
  assemblyId: string,
): Promise<SessionProgressDto> {
  const [projected, treated] = await Promise.all([
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
      .select({ id: controlSheetItems.agendaItemId })
      .from(controlSheetItems)
      .where(
        and(
          eq(controlSheetItems.assemblyId, assemblyId),
          isNotNull(controlSheetItems.treatedAt),
        ),
      ),
  ]);
  return {
    projectedDocumentIds: projected.map((row) => row.id).sort(),
    treatedItemIds: treated.map((row) => row.id).sort(),
  };
}
