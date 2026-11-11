import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq } from "drizzle-orm";
import type { AgendaItemDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  isAutoItem,
  normalizeSubmissionKinds,
} from "~~/shared/utils/agendaSubmissions";
import { agendaItemUpdateBodySchema } from "~~/shared/utils/schemas/assembly";
import { normalizeText } from "~~/shared/utils/schemas/content";
import { db } from "../../../../db";
import { agendaItems } from "../../../../db/schema";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import {
  lockAssembly,
  nextSiblingOrder,
  titleDocumentPayload,
} from "../../../../utils/domain/agendaWrites";
import {
  agendaSubtree,
  canReadItemTitle,
  confirmFinalRootChange,
  loadAgendaItems,
  readAssemblyBody,
  throwAssemblyMutationError,
  loadAgendaItemSlug,
  loadUnlistedItemIds,
  toAgendaItemDto,
} from "../../../../utils/domain/assemblies";
import { diffChanges } from "../../../../utils/domain/changes";
import { recordEvent } from "../../../../utils/domain/events";
import {
  resolveAgendaItem,
  resolveAssembly,
} from "../../../../utils/domain/resolvers";
import { buildOptimisticLockCondition } from "../../../../utils/optimisticLock";

/**
 * Edits an item. Changing `parentId` moves it to the end of its new parent.
 * Once the agenda is final, renaming a root item, moving one under another
 * item or making a sub-item a root item needs `confirmFinal` (409
 * `agenda_final` without it) and the event says `afterFinal`.
 * `submissionKinds` left out keeps the stored kinds; they are emptied when
 * the item stops accepting submissions. A new title given to an automatic
 * sub-item makes it its own (`titleCustom`): it no longer follows the title
 * of its document. A new title given to an item that stayed after its
 * document moved away or was deleted makes it an ordinary one
 * (`hiddenWithDocumentId` and `titleWithheld` cleared).
 *
 * An account that may not read the item's title (canReadItemTitle:
 * `assembly:manage` without `document:manage`, on an item that carries the
 * title of a draft) gets it without title or description, so what it sends
 * for both is ignored and the answer hides them again.
 */
export default defineEventHandler(async (event): Promise<AgendaItemDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const item = await resolveAgendaItem(
    assembly.id,
    getRouterParam(event, "item"),
  );
  const parsed = await readAssemblyBody(event, agendaItemUpdateBodySchema);
  const readsTitle = await canReadItemTitle(actor, item);
  const body = readsTitle
    ? parsed
    : { ...parsed, title: item.title, description: undefined };

  const newParentId =
    body.parentId === undefined ? item.parentId : body.parentId;
  const moved = newParentId !== item.parentId;
  const acceptsSubmissions = body.acceptsSubmissions ?? item.acceptsSubmissions;
  const submissionKinds = normalizeSubmissionKinds(
    acceptsSubmissions,
    body.submissionKinds ?? item.submissionKinds,
  );
  // The body's title is normalized (agendaItemBodySchema); the stored one
  // of an automatic sub-item is its document's, as written.
  const renamed =
    readsTitle &&
    body.title !== normalizeText(item.title).replace(/\s+/g, " ").trim();
  const titleCustom = item.titleCustom || (isAutoItem(item) && renamed);
  // With a title of its own, an item kept after its document moved away or
  // was deleted no longer carries that document's title.
  const releases =
    renamed &&
    (item.hiddenWithDocumentId !== null || item.titleWithheld) &&
    !isAutoItem(item);

  try {
    const updated = await db.transaction(async (tx) => {
      const current = await lockAssembly(tx, assembly.id);
      let order: number | undefined;
      // What changes the root items: a move from or to the root level, and
      // a new title of a root item. Description and submissions do not.
      const changesRoots =
        (moved && (item.parentId === null || newParentId === null)) ||
        (item.parentId === null && body.title !== item.title);
      const afterFinal =
        changesRoots &&
        (await confirmFinalRootChange(tx, current.id, body.confirmFinal));

      if (moved) {
        if (newParentId !== null) {
          const items = await loadAgendaItems(assembly.id, tx);
          if (!items.some((candidate) => candidate.id === newParentId)) {
            throw createError({
              statusCode: 422,
              message: "El punto superior no existe",
            });
          }
          if (agendaSubtree(items, item.id).has(newParentId)) {
            throw createError({
              statusCode: 422,
              message:
                "Un punto no puede colgar de sí mismo ni de sus subpuntos",
            });
          }
        }
        order = await nextSiblingOrder(tx, assembly.id, newParentId);
      }

      const [row] = await tx
        .update(agendaItems)
        .set({
          title: body.title,
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          acceptsSubmissions,
          submissionKinds,
          titleCustom,
          ...(releases
            ? { hiddenWithDocumentId: null, titleWithheld: false }
            : {}),
          ...(moved ? { parentId: newParentId, order } : {}),
        })
        .where(
          and(
            eq(agendaItems.id, item.id),
            eq(agendaItems.assemblyId, assembly.id),
            buildOptimisticLockCondition(agendaItems.updatedAt, body.updatedAt),
          ),
        )
        .returning();
      if (!row) {
        throw createError({
          statusCode: 409,
          message:
            "El punto ha cambiado mientras lo editabas. Recarga e inténtalo de nuevo",
        });
      }

      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "agenda_item",
        entityId: item.id,
        type: "agenda_item_updated",
        payload: {
          ...(moved ? { from: item.parentId, to: newParentId } : {}),
          // The optimistic lock guarantees `item` is the row just replaced.
          changes: diffChanges(item, row, {
            keys: [
              "title",
              "description",
              "acceptsSubmissions",
              "submissionKinds",
              "parentId",
            ],
          }),
          ...(afterFinal ? { afterFinal: true } : {}),
          // An item that carries a document's title (an automatic sub-item,
          // or one that stayed after its document moved away): the history
          // shows its events only to those who see that document.
          ...titleDocumentPayload(item),
        },
        actor,
      });
      return row;
    });

    const [unlisted, slug] = await Promise.all([
      loadUnlistedItemIds(assembly.id),
      loadAgendaItemSlug(assembly.id, updated.id),
    ]);
    return toAgendaItemDto(
      updated,
      !readsTitle,
      unlisted.has(updated.id),
      slug,
    );
  } catch (error) {
    throwAssemblyMutationError("agenda.update", error, event);
  }
});
