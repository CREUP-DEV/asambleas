import { createError } from "h3";
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  agendaItems,
  assemblies,
  documents,
  liveState,
  speakingTurns,
} from "../../db/schema";
import type { Actor } from "./actor";
import { diffChanges } from "./changes";
import { recordEvent, type Executor } from "./events";
import {
  autoItemRemovable,
  followsDocumentTitle,
} from "~~/shared/utils/agendaSubmissions";

/**
 * Agenda writes shared by the agenda endpoints and the document paths: the
 * assembly lock, sibling order and the automatic sub-items of documents
 * presented under an item that accepts submissions. Never import
 * ./assemblies or ./documents here: both import this module.
 */

type AssemblyRow = typeof assemblies.$inferSelect;
type AgendaItemRow = typeof agendaItems.$inferSelect;

/**
 * Serializes concurrent writes on the same assembly (agenda, calendar, live
 * state). The lock is the first one its transaction takes; the order and
 * strengths every transaction follows are under "Row locks" in documents.ts
 * (shareLockAssembly). NO KEY UPDATE conflicts with itself and with the share
 * lock of the vote, projection and document delete paths, but not with the
 * FOR KEY SHARE that every event, vote or document insert takes on the
 * assembly, so those never wait here. None of the callers deletes the row
 * or changes its key (id, type, number).
 *
 * Every transaction that writes agenda rows takes it: the agenda endpoints,
 * and the document paths that create, rename or remove an automatic
 * sub-item (create, bulk create, a rename, a move and a delete).
 */
export async function lockAssembly(
  tx: Executor,
  assemblyId: string,
): Promise<AssemblyRow> {
  const [row] = await tx
    .select()
    .from(assemblies)
    .where(eq(assemblies.id, assemblyId))
    .for("no key update");
  if (!row) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }
  return row;
}

/** Next `order` among the children of `parentId` (null = root items). */
export async function nextSiblingOrder(
  executor: Executor,
  assemblyId: string,
  parentId: string | null,
): Promise<number> {
  const [row] = await executor
    .select({ last: sql<number | null>`max(${agendaItems.order})` })
    .from(agendaItems)
    .where(
      and(
        eq(agendaItems.assemblyId, assemblyId),
        parentId
          ? eq(agendaItems.parentId, parentId)
          : isNull(agendaItems.parentId),
      ),
    );
  const last = row?.last;
  return last === null || last === undefined ? 0 : Number(last) + 1;
}

// Automatic sub-items ---------------------------------------------------------

/**
 * Inserts the sub-item a document gets under an item that accepts
 * submissions: titled like the document, last among its siblings, taking no
 * submissions itself. The caller creates (or moves) the document into it
 * and then calls bindAutoItem. Needs lockAssembly.
 */
export async function insertAutoItem(
  tx: Executor,
  input: { assemblyId: string; parentId: string; title: string },
): Promise<AgendaItemRow> {
  const [created] = await tx
    .insert(agendaItems)
    .values({
      assemblyId: input.assemblyId,
      parentId: input.parentId,
      title: input.title,
      acceptsSubmissions: false,
      order: await nextSiblingOrder(tx, input.assemblyId, input.parentId),
    })
    .returning();
  if (!created) {
    throw createError({
      statusCode: 500,
      message: "No se pudo crear el punto",
    });
  }
  return created;
}

/**
 * Marks the sub-item as the automatic one of its document, which must exist
 * by now, and records `agenda_item_created` with `auto: true`. Being a
 * sub-item, it never needs `confirmFinal` nor carries `afterFinal`. The
 * payload names the document so the history shows the event only to those
 * who see that document (a draft's title is its presenters').
 */
export async function bindAutoItem(
  tx: Executor,
  input: {
    assemblyId: string;
    item: Pick<AgendaItemRow, "id" | "parentId" | "title">;
    documentId: string;
    actor: Actor;
  },
): Promise<void> {
  await tx
    .update(agendaItems)
    .set({ generatedForDocumentId: input.documentId })
    .where(eq(agendaItems.id, input.item.id));
  await recordEvent(tx, {
    assemblyId: input.assemblyId,
    entityType: "agenda_item",
    entityId: input.item.id,
    type: "agenda_item_created",
    payload: {
      parentId: input.item.parentId,
      title: input.item.title,
      auto: true,
      documentId: input.documentId,
    },
    actor: input.actor,
  });
}

/**
 * The automatic sub-item of a document that goes with it when the document
 * is deleted or moved away: the item it hangs from, if that was created for
 * it and holds no other document and no sub-item. Null otherwise. Call it
 * before the delete or the move, and removeAutoItem after it.
 */
export async function findRemovableAutoItem(
  tx: Executor,
  document: { id: string; agendaItemId: string },
): Promise<AgendaItemRow | null> {
  const [item] = await tx
    .select()
    .from(agendaItems)
    .where(eq(agendaItems.id, document.agendaItemId));
  if (!item || item.generatedForDocumentId !== document.id) return null;
  const [[others], [children]] = await Promise.all([
    tx
      .select({ total: count() })
      .from(documents)
      .where(
        and(eq(documents.agendaItemId, item.id), ne(documents.id, document.id)),
      ),
    tx
      .select({ total: count() })
      .from(agendaItems)
      .where(eq(agendaItems.parentId, item.id)),
  ]);
  return autoItemRemovable(item, document.id, {
    otherDocuments: Number(others?.total ?? 0),
    children: Number(children?.total ?? 0),
  })
    ? item
    : null;
}

/**
 * The automatic sub-item of a document that moved away but stays because
 * it holds something else (findRemovableAutoItem answered null) becomes an
 * ordinary item: it no longer counts as that document's, for the deadline
 * of what hangs from it, the agenda or the history. Records
 * `agenda_item_updated` with `auto: true`, the last event of the item tied
 * to the document. Needs lockAssembly.
 */
export async function unbindAutoItem(
  tx: Executor,
  input: {
    assemblyId: string;
    item: Pick<AgendaItemRow, "id">;
    documentId: string;
    actor: Actor;
  },
): Promise<void> {
  await tx
    .update(agendaItems)
    .set({ generatedForDocumentId: null })
    .where(eq(agendaItems.id, input.item.id));
  await recordEvent(tx, {
    assemblyId: input.assemblyId,
    entityType: "agenda_item",
    entityId: input.item.id,
    type: "agenda_item_updated",
    payload: { auto: true, documentId: input.documentId },
    actor: input.actor,
  });
}

/**
 * Moves what the session points at from agenda items about to go to
 * `toItemId` (their parent): the open speaking turns and the live
 * projection, whose foreign keys would otherwise clear the pointer without
 * a trace. Records `live_changed` when the projection moves.
 */
async function repointSession(
  tx: Executor,
  input: {
    assemblyId: string;
    fromItemIds: string[];
    toItemId: string | null;
    actor: Actor;
  },
): Promise<void> {
  if (input.fromItemIds.length === 0) return;
  await tx
    .update(speakingTurns)
    .set({ agendaItemId: input.toItemId })
    .where(
      and(
        eq(speakingTurns.assemblyId, input.assemblyId),
        inArray(speakingTurns.agendaItemId, input.fromItemIds),
        inArray(speakingTurns.status, ["waiting", "speaking"]),
      ),
    );
  const [live] = await tx
    .select({
      agendaItemId: liveState.agendaItemId,
      documentId: liveState.documentId,
      amendmentId: liveState.amendmentId,
      voteId: liveState.voteId,
    })
    .from(liveState)
    .where(eq(liveState.assemblyId, input.assemblyId))
    .for("no key update");
  if (!live?.agendaItemId || !input.fromItemIds.includes(live.agendaItemId)) {
    return;
  }
  await tx
    .update(liveState)
    .set({
      agendaItemId: input.toItemId,
      updatedByUserId: input.actor.user.id,
      updatedAt: sql`now()`,
    })
    .where(eq(liveState.assemblyId, input.assemblyId));
  await recordEvent(tx, {
    assemblyId: input.assemblyId,
    entityType: "live",
    entityId: input.assemblyId,
    type: "live_changed",
    // Same shape as updateLiveState: ids only.
    payload: {
      changed: ["agendaItemId"],
      agendaItemId: input.toItemId,
      documentId: live.documentId,
      amendmentId: live.amendmentId,
      voteId: live.voteId,
    },
    actor: input.actor,
  });
}

/**
 * Deletes an automatic sub-item left empty (findRemovableAutoItem) once its
 * document is gone or hangs elsewhere, and records `agenda_item_deleted`
 * with `auto: true`. The session keeps going on its parent. Needs
 * lockAssembly.
 */
export async function removeAutoItem(
  tx: Executor,
  input: {
    assemblyId: string;
    item: Pick<AgendaItemRow, "id" | "parentId" | "title">;
    documentId: string;
    actor: Actor;
  },
): Promise<void> {
  const { item } = input;
  await repointSession(tx, {
    assemblyId: input.assemblyId,
    fromItemIds: [item.id],
    toItemId: item.parentId,
    actor: input.actor,
  });
  await tx.delete(agendaItems).where(eq(agendaItems.id, item.id));
  await recordEvent(tx, {
    assemblyId: input.assemblyId,
    entityType: "agenda_item",
    entityId: item.id,
    type: "agenda_item_deleted",
    // An explicit allowlist, as in the agenda delete.
    payload: {
      parentId: item.parentId,
      deletedIds: [item.id],
      title: item.title,
      deletedItems: [{ id: item.id, title: item.title }],
      auto: true,
      documentId: input.documentId,
    },
    actor: input.actor,
  });
}

/**
 * Gives the automatic sub-item of a document its new title, unless a
 * manager already gave the item its own (followsDocumentTitle). Records
 * `agenda_item_updated` with `auto: true`. Needs lockAssembly.
 */
export async function syncAutoItemTitle(
  tx: Executor,
  input: {
    assemblyId: string;
    document: { id: string; agendaItemId: string };
    title: string;
    actor: Actor;
  },
): Promise<void> {
  const [item] = await tx
    .select()
    .from(agendaItems)
    .where(eq(agendaItems.id, input.document.agendaItemId));
  if (
    !item ||
    !followsDocumentTitle(item, input.document) ||
    item.title === input.title
  ) {
    return;
  }
  await tx
    .update(agendaItems)
    .set({ title: input.title })
    .where(eq(agendaItems.id, item.id));
  await recordEvent(tx, {
    assemblyId: input.assemblyId,
    entityType: "agenda_item",
    entityId: item.id,
    type: "agenda_item_updated",
    payload: {
      changes: diffChanges({ title: item.title }, { title: input.title }),
      auto: true,
      documentId: input.document.id,
    },
    actor: input.actor,
  });
}
