import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq } from "drizzle-orm";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { buildAssemblySlug } from "~~/shared/utils/slug";
import { db } from "../../../db";
import { assemblies, auditLog } from "../../../db/schema";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import { throwAssemblyMutationError } from "../../../utils/domain/assemblies";
import { recordEvent } from "../../../utils/domain/events";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/** Deletes a draft assembly with everything it holds. */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  if (assembly.status !== "draft") {
    throw createError({
      statusCode: 409,
      message: "Solo se pueden eliminar asambleas en borrador",
    });
  }

  try {
    await db.transaction(async (tx) => {
      // Notify first: the event row needs the assembly and goes away with it,
      // but the notification still reaches open streams on commit.
      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "assembly",
        entityId: assembly.id,
        type: "assembly_deleted",
        actor,
      });
      const deleted = await tx
        .delete(assemblies)
        .where(
          and(eq(assemblies.id, assembly.id), eq(assemblies.status, "draft")),
        )
        .returning({ id: assemblies.id });
      if (deleted.length === 0) {
        throw createError({
          statusCode: 409,
          message: "Solo se pueden eliminar asambleas en borrador",
        });
      }
      // The audit log has no foreign key, so it keeps the trace of the deletion.
      await tx.insert(auditLog).values({
        actorUserId: actor.user.id,
        action: "assembly.delete",
        targetType: "assembly",
        targetId: assembly.id,
        before: {
          slug: buildAssemblySlug(assembly),
          number: assembly.number,
          type: assembly.type,
          startDate: assembly.startDate.toISOString(),
          location: assembly.location,
        },
        after: null,
      });
    });
    return { success: true };
  } catch (error) {
    throwAssemblyMutationError("assemblies.delete", error, event);
  }
});
