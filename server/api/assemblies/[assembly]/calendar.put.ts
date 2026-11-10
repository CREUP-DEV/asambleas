import { defineEventHandler, getRouterParam } from "h3";
import { and, eq } from "drizzle-orm";
import type { AssemblyDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { calendarBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../db";
import { assemblies, assemblyMilestones } from "../../../db/schema";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import { lockAssembly } from "../../../utils/domain/agendaWrites";
import {
  loadAssemblyDto,
  readAssemblyBody,
  throwAssemblyMutationError,
} from "../../../utils/domain/assemblies";
import { diffChanges } from "../../../utils/domain/changes";
import { recordEvent } from "../../../utils/domain/events";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/**
 * Upserts the listed milestones (a null date deletes one) and marks the
 * agenda as final or reopens it. Milestones that are not listed stay as they are.
 */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, calendarBodySchema);

  try {
    await db.transaction(async (tx) => {
      const current = await lockAssembly(tx, assembly.id);
      const updated: string[] = [];
      const removed: string[] = [];
      // Date and note of each listed milestone before and after, for the
      // history ("key" and "key.note"); the assembly lock keeps them still.
      const stored = new Map(
        (
          await tx
            .select({
              key: assemblyMilestones.key,
              at: assemblyMilestones.at,
              note: assemblyMilestones.note,
            })
            .from(assemblyMilestones)
            .where(eq(assemblyMilestones.assemblyId, assembly.id))
        ).map((row) => [row.key, row]),
      );
      const before: Record<string, Date | string | null> = {};
      const after: Record<string, Date | string | null> = {};

      for (const milestone of body.milestones) {
        const previous = stored.get(milestone.key);
        before[milestone.key] = previous?.at ?? null;
        before[`${milestone.key}.note`] = previous?.note ?? null;
        after[milestone.key] =
          milestone.at === null ? null : new Date(milestone.at);
        after[`${milestone.key}.note`] =
          milestone.at === null
            ? null
            : milestone.note === undefined
              ? (previous?.note ?? null)
              : milestone.note;

        if (milestone.at === null) {
          const rows = await tx
            .delete(assemblyMilestones)
            .where(
              and(
                eq(assemblyMilestones.assemblyId, assembly.id),
                eq(assemblyMilestones.key, milestone.key),
              ),
            )
            .returning({ id: assemblyMilestones.id });
          if (rows.length > 0) removed.push(milestone.key);
          continue;
        }
        const at = new Date(milestone.at);
        const note =
          milestone.note === undefined ? {} : { note: milestone.note };
        await tx
          .insert(assemblyMilestones)
          .values({ assemblyId: assembly.id, key: milestone.key, at, ...note })
          .onConflictDoUpdate({
            target: [assemblyMilestones.assemblyId, assemblyMilestones.key],
            set: { at, ...note },
          });
        updated.push(milestone.key);
      }

      if (updated.length > 0 || removed.length > 0) {
        await recordEvent(tx, {
          assemblyId: assembly.id,
          entityType: "assembly",
          entityId: assembly.id,
          type: "calendar_updated",
          payload: { updated, removed, changes: diffChanges(before, after) },
          actor,
        });
      }

      const wasFinal = current.agendaFinalizedAt !== null;
      if (body.agendaFinal !== undefined && body.agendaFinal !== wasFinal) {
        await tx
          .update(assemblies)
          .set({ agendaFinalizedAt: body.agendaFinal ? new Date() : null })
          .where(eq(assemblies.id, assembly.id));
        await recordEvent(tx, {
          assemblyId: assembly.id,
          entityType: "assembly",
          entityId: assembly.id,
          type: body.agendaFinal ? "agenda_finalized" : "agenda_reopened",
          actor,
        });
      }
    });

    return await loadAssemblyDto(actor, assembly.id);
  } catch (error) {
    throwAssemblyMutationError("assemblies.calendar", error, event);
  }
});
