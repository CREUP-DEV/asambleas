import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq, sql } from "drizzle-orm";
import type { AssemblyDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { assemblyUpdateBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import {
  assertDateRange,
  findAssemblyByTypeNumber,
  loadAssemblyDto,
  readAssemblyBody,
  throwAssemblyMutationError,
} from "../../../utils/domain/assemblies";
import { diffChanges } from "../../../utils/domain/changes";
import { assemblySettings } from "../../../utils/domain/documents";
import { recordEvent } from "../../../utils/domain/events";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { buildOptimisticLockCondition } from "../../../utils/optimisticLock";

/** Edits the assembly. Settings are merged over the stored ones. */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const { updatedAt, settings, startDate, endDate, ...fields } =
    await readAssemblyBody(event, assemblyUpdateBodySchema);

  const nextStart = startDate ? new Date(startDate) : assembly.startDate;
  const nextEnd = endDate ? new Date(endDate) : assembly.endDate;
  assertDateRange(nextStart, nextEnd);

  const values: Partial<typeof assemblies.$inferInsert> = {
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ),
    ...(startDate ? { startDate: nextStart } : {}),
    ...(endDate ? { endDate: nextEnd } : {}),
    ...(settings
      ? { settings: { ...assemblySettings(assembly), ...settings } }
      : {}),
  };
  const changed = Object.keys(values);
  // What really changed, per field and per setting (the stored values are
  // the ones the optimistic lock below guarantees).
  const { settings: nextSettings, ...scalars } = values;
  const changes = {
    ...diffChanges(assembly, scalars),
    ...(nextSettings
      ? diffChanges(assemblySettings(assembly), nextSettings, {
          prefix: "settings.",
        })
      : {}),
  };

  try {
    await db.transaction(async (tx) => {
      const nextType = values.type ?? assembly.type;
      const nextNumber = values.number ?? assembly.number;
      if (
        (nextType !== assembly.type || nextNumber !== assembly.number) &&
        (await findAssemblyByTypeNumber(nextType, nextNumber, tx, assembly.id))
      ) {
        throw createError({
          statusCode: 409,
          message: "Ya existe una asamblea de ese tipo con ese número",
        });
      }

      const [row] = await tx
        .update(assemblies)
        // An empty patch still bumps updatedAt, which keeps the lock honest.
        .set({ ...values, updatedAt: sql`now()` })
        .where(
          and(
            eq(assemblies.id, assembly.id),
            buildOptimisticLockCondition(assemblies.updatedAt, updatedAt),
          ),
        )
        .returning({ id: assemblies.id });
      if (!row) {
        throw createError({
          statusCode: 409,
          message:
            "La asamblea ha cambiado mientras la editabas. Recarga e inténtalo de nuevo",
        });
      }

      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "assembly",
        entityId: assembly.id,
        type: "assembly_updated",
        payload: { fields: changed, changes },
        actor,
      });
    });

    return await loadAssemblyDto(actor, assembly.id);
  } catch (error) {
    throwAssemblyMutationError("assemblies.update", error, event);
  }
});
