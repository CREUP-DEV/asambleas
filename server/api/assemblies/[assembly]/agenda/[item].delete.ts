import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq, inArray } from "drizzle-orm";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  AGENDA_DELETE_AMENDMENTS_CODE,
  AGENDA_DELETE_LIVE_CODE,
  agendaDeleteBlocker,
  carriesGuardedTitle,
} from "~~/shared/utils/agendaSubmissions";
import { agendaItemDeleteQuerySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../../db";
import { agendaItems, liveState, speakingTurns } from "../../../../db/schema";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import {
  lockAssembly,
  titleDocumentPayload,
} from "../../../../utils/domain/agendaWrites";
import {
  agendaSubtree,
  confirmFinalRootChange,
  loadAgendaItems,
  readAssemblyQuery,
  throwAssemblyMutationError,
} from "../../../../utils/domain/assemblies";
import { agendaSubtreeEntries } from "../../../../utils/domain/changes";
import { removeImageFiles } from "../../../../utils/domain/documentImages";
import {
  lockDocumentsUnder,
  removeDocument,
  removeStoredPdf,
  type DeletedDocumentFiles,
} from "../../../../utils/domain/documents";
import { recordEvent, type Executor } from "../../../../utils/domain/events";
import {
  resolveAgendaItem,
  resolveAssembly,
} from "../../../../utils/domain/resolvers";

/**
 * Whether the session is on something about to be deleted: the projection
 * shows one of the items or documents, or one of the items has a speaking
 * turn waiting or in progress.
 */
async function sessionIsOn(
  tx: Executor,
  assemblyId: string,
  itemIds: string[],
  documentIds: string[],
): Promise<boolean> {
  const [live] = await tx
    .select({
      agendaItemId: liveState.agendaItemId,
      documentId: liveState.documentId,
    })
    .from(liveState)
    .where(eq(liveState.assemblyId, assemblyId));
  if (live?.agendaItemId && itemIds.includes(live.agendaItemId)) return true;
  if (live?.documentId && documentIds.includes(live.documentId)) return true;
  const [turn] = await tx
    .select({ id: speakingTurns.id })
    .from(speakingTurns)
    .where(
      and(
        eq(speakingTurns.assemblyId, assemblyId),
        inArray(speakingTurns.agendaItemId, itemIds),
        inArray(speakingTurns.status, ["waiting", "speaking"]),
      ),
    )
    .limit(1);
  return turn !== undefined;
}

/**
 * Deletes an item with its sub-items and every document under them
 * (assembly:manage). Only amendments keep it: while any of those documents
 * has an amendment of any status (drafts and withdrawn ones included) the
 * answer is 409 `agenda_item_amendments` with how many. During the session
 * it is also refused (409 `agenda_item_live`) while the projection or an
 * open speaking turn is on one of them. A root item of a final agenda needs
 * `?confirmFinal=true` (409 `agenda_final` without it) and the event says
 * `afterFinal`.
 *
 * Each document goes as in DELETE .../documents/[document] (removeDocument:
 * its `document_deleted`, votes, projection, then its PDF and images once
 * the delete commits), and each item records its own `agenda_item_deleted`.
 */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const resolved = await resolveAgendaItem(
    assembly.id,
    getRouterParam(event, "item"),
  );
  const { confirmFinal } = readAssemblyQuery(
    event,
    agendaItemDeleteQuerySchema,
  );

  let files: DeletedDocumentFiles[] = [];
  try {
    files = await db.transaction(async (tx) => {
      const current = await lockAssembly(tx, assembly.id);
      // Read again under the lock: a concurrent move may have made it a
      // root item (or deleted it) since it was resolved.
      const items = await loadAgendaItems(assembly.id, tx);
      const item = items.find((candidate) => candidate.id === resolved.id);
      if (!item) {
        throw createError({
          statusCode: 404,
          message: "Punto no encontrado",
        });
      }
      const afterFinal =
        item.parentId === null && confirmFinalRootChange(current, confirmFinal);

      const itemIds = [...agendaSubtree(items, item.id)];
      // Locked FOR UPDATE after the assembly: an amendment being inserted
      // finishes first and is counted, and no document moves in or out
      // meanwhile (creating, moving and deleting one take the assembly lock).
      const held = await lockDocumentsUnder(tx, itemIds);
      const blocker = agendaDeleteBlocker(
        held.map((entry) => entry.amendments),
      );
      if (blocker) {
        throw createError({
          statusCode: 409,
          message:
            "No se puede eliminar: hay documentos con enmiendas en este punto o en sus subpuntos",
          data: { code: AGENDA_DELETE_AMENDMENTS_CODE, ...blocker },
        });
      }
      if (
        current.status === "in_session" &&
        (await sessionIsOn(
          tx,
          assembly.id,
          itemIds,
          held.map((entry) => entry.document.id),
        ))
      ) {
        throw createError({
          statusCode: 409,
          message:
            "No se puede eliminar durante la sesión: se está tratando este punto, un subpunto o uno de sus documentos",
          data: { code: AGENDA_DELETE_LIVE_CODE },
        });
      }

      const removed: DeletedDocumentFiles[] = [];
      for (const { document } of held) {
        removed.push(
          await removeDocument(tx, {
            assemblyId: assembly.id,
            document,
            actor,
            // The items go below, each with its own event.
            keepAgendaItem: true,
          }),
        );
      }

      // The item itself first, then what hung from it. Its event lists the
      // sub-items written by hand; one that carries the title of a document
      // (titleDocumentId) says it only in its own event, which the history
      // shows to those who could see that document.
      const entries = agendaSubtreeEntries(items, item.id);
      const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
      for (const entry of entries) {
        const row = byId.get(entry.id)!;
        const isRoot = row.id === item.id;
        await recordEvent(tx, {
          assemblyId: assembly.id,
          entityType: "agenda_item",
          entityId: row.id,
          type: "agenda_item_deleted",
          // An explicit allowlist: what was deleted, never the whole row.
          payload: {
            parentId: row.parentId,
            title: row.title,
            deletedIds: isRoot ? itemIds : [row.id],
            deletedItems: isRoot
              ? entries.filter(
                  (candidate) =>
                    candidate.id === item.id ||
                    !carriesGuardedTitle(byId.get(candidate.id)!),
                )
              : [entry],
            ...(isRoot ? { deletedDocuments: held.length } : { cascade: true }),
            ...titleDocumentPayload(row),
            ...(isRoot && afterFinal ? { afterFinal: true } : {}),
          },
          actor,
        });
      }
      await tx
        .delete(agendaItems)
        .where(
          and(
            eq(agendaItems.id, item.id),
            eq(agendaItems.assemblyId, assembly.id),
          ),
        );
      return removed;
    });
  } catch (error) {
    throwAssemblyMutationError("agenda.delete", error, event);
  }

  // Best effort, once nothing points at them.
  for (const file of files) {
    await removeStoredPdf(file.fileUrl);
    await removeImageFiles(file.images);
  }
  return { success: true };
});
