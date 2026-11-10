import { createError, defineEventHandler, getRouterParam } from "h3";
import { eq } from "drizzle-orm";
import type { AgendaDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { agendaReorderBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../../db";
import { agendaItems } from "../../../../db/schema";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import { lockAssembly } from "../../../../utils/domain/agendaWrites";
import {
  confirmFinalRootChange,
  hasAgendaCycle,
  loadAgendaDto,
  loadAgendaItems,
  readAssemblyBody,
  rootSequence,
  throwAssemblyMutationError,
} from "../../../../utils/domain/assemblies";
import { recordEvent } from "../../../../utils/domain/events";
import { resolveAssembly } from "../../../../utils/domain/resolvers";

/**
 * Sets parent and order of the listed items; the rest keep theirs. Every id
 * and parent must belong to the assembly and the result must be a tree. Once
 * the agenda is final, changing the sequence of root items needs
 * `confirmFinal` (409 `agenda_final` without it) and the event says
 * `afterFinal`. Returns the whole agenda, as GET does.
 */
export default defineEventHandler(async (event): Promise<AgendaDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, agendaReorderBodySchema);

  try {
    await db.transaction(async (tx) => {
      const current = await lockAssembly(tx, assembly.id);
      const items = await loadAgendaItems(assembly.id, tx);
      const byId = new Map(items.map((item) => [item.id, item]));

      for (const entry of body.items) {
        if (
          !byId.has(entry.id) ||
          (entry.parentId !== null && !byId.has(entry.parentId))
        ) {
          throw createError({
            statusCode: 422,
            message: "Algún punto no pertenece a esta asamblea",
          });
        }
      }

      const changes = body.items.filter((entry) => {
        const item = byId.get(entry.id)!;
        return item.parentId !== entry.parentId || item.order !== entry.order;
      });
      if (changes.length === 0) return;

      const next = items.map((item) => {
        const change = changes.find((entry) => entry.id === item.id);
        return change
          ? { ...item, parentId: change.parentId, order: change.order }
          : item;
      });
      if (
        hasAgendaCycle(new Map(next.map((item) => [item.id, item.parentId])))
      ) {
        throw createError({
          statusCode: 422,
          message: "Un punto no puede colgar de sí mismo ni de sus subpuntos",
        });
      }
      const afterFinal =
        rootSequence(items).join(",") !== rootSequence(next).join(",") &&
        confirmFinalRootChange(current, body.confirmFinal);

      for (const change of changes) {
        await tx
          .update(agendaItems)
          .set({ parentId: change.parentId, order: change.order })
          .where(eq(agendaItems.id, change.id));
      }
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "assembly",
        entityId: assembly.id,
        type: "agenda_reordered",
        payload: {
          itemIds: changes.map((change) => change.id),
          // Where each listed item was and where it went.
          moves: changes.map((change) => {
            const item = byId.get(change.id)!;
            return {
              id: change.id,
              from: { parentId: item.parentId, order: item.order },
              to: { parentId: change.parentId, order: change.order },
            };
          }),
          ...(afterFinal ? { afterFinal: true } : {}),
        },
        actor,
      });
    });

    return await loadAgendaDto(actor, assembly);
  } catch (error) {
    throwAssemblyMutationError("agenda.reorder", error, event);
  }
});
