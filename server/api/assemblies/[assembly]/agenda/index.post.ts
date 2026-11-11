import {
  createError,
  defineEventHandler,
  getRouterParam,
  setResponseStatus,
} from "h3";
import { and, eq } from "drizzle-orm";
import type { AgendaItemDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { normalizeSubmissionKinds } from "~~/shared/utils/agendaSubmissions";
import { agendaItemBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../../db";
import { agendaItems } from "../../../../db/schema";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import {
  lockAssembly,
  nextSiblingOrder,
} from "../../../../utils/domain/agendaWrites";
import {
  confirmFinalRootChange,
  loadAgendaItemSlug,
  readAssemblyBody,
  throwAssemblyMutationError,
  toAgendaItemDto,
} from "../../../../utils/domain/assemblies";
import { recordEvent } from "../../../../utils/domain/events";
import { resolveAssembly } from "../../../../utils/domain/resolvers";

/**
 * Adds an item at the end of its parent (or of the root items). A root item
 * on a final agenda needs `confirmFinal` (409 `agenda_final` without it) and
 * its event says `afterFinal`. With `acceptsSubmissions` members present
 * documents under it, of the kinds in `submissionKinds` (none means every
 * kind).
 */
export default defineEventHandler(async (event): Promise<AgendaItemDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, agendaItemBodySchema);
  const parentId = body.parentId ?? null;
  const acceptsSubmissions = body.acceptsSubmissions ?? false;
  const submissionKinds = normalizeSubmissionKinds(
    acceptsSubmissions,
    body.submissionKinds,
  );

  try {
    const item = await db.transaction(async (tx) => {
      const current = await lockAssembly(tx, assembly.id);
      let afterFinal = false;
      if (parentId === null) {
        afterFinal = confirmFinalRootChange(current, body.confirmFinal);
      } else {
        const [parent] = await tx
          .select({ id: agendaItems.id })
          .from(agendaItems)
          .where(
            and(
              eq(agendaItems.id, parentId),
              eq(agendaItems.assemblyId, assembly.id),
            ),
          );
        if (!parent) {
          throw createError({
            statusCode: 422,
            message: "El punto superior no existe",
          });
        }
      }

      const [created] = await tx
        .insert(agendaItems)
        .values({
          assemblyId: assembly.id,
          parentId,
          title: body.title,
          description: body.description ?? null,
          acceptsSubmissions,
          submissionKinds,
          order: await nextSiblingOrder(tx, assembly.id, parentId),
        })
        .returning();
      if (!created) {
        throw createError({
          statusCode: 500,
          message: "No se pudo crear el punto",
        });
      }

      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "agenda_item",
        entityId: created.id,
        type: "agenda_item_created",
        payload: {
          parentId,
          title: created.title,
          ...(acceptsSubmissions
            ? { acceptsSubmissions, submissionKinds }
            : {}),
          ...(afterFinal ? { afterFinal: true } : {}),
        },
        actor,
      });
      return created;
    });

    setResponseStatus(event, 201);
    return toAgendaItemDto(
      item,
      false,
      false,
      await loadAgendaItemSlug(assembly.id, item.id),
    );
  } catch (error) {
    throwAssemblyMutationError("agenda.create", error, event);
  }
});
