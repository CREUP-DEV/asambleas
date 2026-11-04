import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq } from "drizzle-orm";
import type { AgendaItemDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { agendaItemUpdateBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../../db";
import { agendaItems } from "../../../../db/schema";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import {
  agendaSubtree,
  assertRootsUnlocked,
  loadAgendaItems,
  lockAssembly,
  nextSiblingOrder,
  readAssemblyBody,
  throwAssemblyMutationError,
  toAgendaItemDto,
} from "../../../../utils/domain/assemblies";
import { recordEvent } from "../../../../utils/domain/events";
import {
  resolveAgendaItem,
  resolveAssembly,
} from "../../../../utils/domain/resolvers";
import { buildOptimisticLockCondition } from "../../../../utils/optimisticLock";

/**
 * Edits an item. Changing `parentId` moves it to the end of its new parent;
 * once the agenda is final, root items cannot be moved and no sub-item can
 * become a root item.
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
  const body = await readAssemblyBody(event, agendaItemUpdateBodySchema);

  const newParentId =
    body.parentId === undefined ? item.parentId : body.parentId;
  const moved = newParentId !== item.parentId;

  try {
    const updated = await db.transaction(async (tx) => {
      const current = await lockAssembly(tx, assembly.id);
      let order: number | undefined;

      if (moved) {
        if (item.parentId === null || newParentId === null)
          assertRootsUnlocked(current);
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
          ...(body.acceptsSubmissions !== undefined
            ? { acceptsSubmissions: body.acceptsSubmissions }
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
        payload: moved ? { from: item.parentId, to: newParentId } : {},
        actor,
      });
      return row;
    });

    return toAgendaItemDto(updated);
  } catch (error) {
    throwAssemblyMutationError("agenda.update", error, event);
  }
});
