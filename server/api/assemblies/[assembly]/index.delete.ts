import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, asc, count, eq } from "drizzle-orm";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { buildAssemblySlug } from "~~/shared/utils/slug";
import { db } from "../../../db";
import { agendaItems, assemblies, documents, events } from "../../../db/schema";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import { throwAssemblyMutationError } from "../../../utils/domain/assemblies";
import { recordAudit } from "../../../utils/domain/audit";
import { removeConvocationPdf } from "../../../utils/domain/convocation";
import { recordEvent, type Executor } from "../../../utils/domain/events";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/** Most events copied into the deletion's audit row (drafts hold few). */
const DELETED_EVENTS_LIMIT = 1_000;

/**
 * What survives a draft assembly in its `assembly.delete` row: the events
 * cascade away with it, so a compact copy of them (no payloads) and the
 * counts of what it held go into `before`.
 */
async function deletedAssemblyTrace(tx: Executor, assemblyId: string) {
  const history = await tx
    .select({
      type: events.type,
      entityType: events.entityType,
      entityId: events.entityId,
      actorUserId: events.actorUserId,
      actorMemberId: events.actorMemberId,
      impersonationId: events.impersonationId,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(eq(events.assemblyId, assemblyId))
    .orderBy(asc(events.createdAt), asc(events.id))
    .limit(DELETED_EVENTS_LIMIT + 1);
  const [agenda] = await tx
    .select({ value: count() })
    .from(agendaItems)
    .where(eq(agendaItems.assemblyId, assemblyId));
  const [docs] = await tx
    .select({ value: count() })
    .from(documents)
    .where(eq(documents.assemblyId, assemblyId));
  return {
    agendaItemCount: agenda?.value ?? 0,
    documentCount: docs?.value ?? 0,
    events: history.slice(0, DELETED_EVENTS_LIMIT).map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
    eventsTruncated: history.length > DELETED_EVENTS_LIMIT,
  };
}

/**
 * Deletes a draft assembly with everything it holds. The audit row
 * `assembly.delete` keeps a summary, the counts and a compact copy of its
 * history (deletedAssemblyTrace).
 */
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
      // Read before the delete: the events cascade with the assembly.
      const trace = await deletedAssemblyTrace(tx, assembly.id);
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
      await recordAudit(tx, {
        event,
        actor,
        action: AUDIT_ACTIONS.ASSEMBLY_DELETE,
        targetType: "assembly",
        targetId: assembly.id,
        assemblyId: assembly.id,
        before: {
          slug: buildAssemblySlug(assembly),
          number: assembly.number,
          type: assembly.type,
          startDate: assembly.startDate.toISOString(),
          location: assembly.location,
          ...trace,
        },
      });
    });
    // Its signed convocatoria, if any, has nobody pointing to it any more.
    await removeConvocationPdf(assembly.convocationFileUrl);
    return { success: true };
  } catch (error) {
    throwAssemblyMutationError("assemblies.delete", error, event);
  }
});
