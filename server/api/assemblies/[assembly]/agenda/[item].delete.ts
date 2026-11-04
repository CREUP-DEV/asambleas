import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq } from "drizzle-orm";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { db } from "../../../../db";
import { agendaItems } from "../../../../db/schema";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import {
  agendaSubtree,
  assertRootsUnlocked,
  hasProtectedDocuments,
  loadAgendaItems,
  lockAssembly,
  throwAssemblyMutationError,
} from "../../../../utils/domain/assemblies";
import { recordEvent } from "../../../../utils/domain/events";
import {
  resolveAgendaItem,
  resolveAssembly,
} from "../../../../utils/domain/resolvers";

/**
 * Deletes an item and its sub-items. Refused while any of them holds a
 * submitted, published or postponed document, or one that was ever published
 * (withdrawn after publication included), whose versions, reference and
 * amendments must survive. Drafts and documents withdrawn before publication
 * are deleted with them.
 */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
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

  try {
    await db.transaction(async (tx) => {
      const current = await lockAssembly(tx, assembly.id);
      if (item.parentId === null) assertRootsUnlocked(current);

      const subtree = agendaSubtree(
        await loadAgendaItems(assembly.id, tx),
        item.id,
      );
      if (await hasProtectedDocuments(tx, [...subtree])) {
        throw createError({
          statusCode: 409,
          message:
            "El punto o sus subpuntos contienen documentos presentados o que ya se han publicado",
        });
      }

      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "agenda_item",
        entityId: item.id,
        type: "agenda_item_deleted",
        payload: { parentId: item.parentId, deletedIds: [...subtree] },
        actor,
      });
      await tx
        .delete(agendaItems)
        .where(
          and(
            eq(agendaItems.id, item.id),
            eq(agendaItems.assemblyId, assembly.id),
          ),
        );
    });
    return { success: true };
  } catch (error) {
    throwAssemblyMutationError("agenda.delete", error, event);
  }
});
