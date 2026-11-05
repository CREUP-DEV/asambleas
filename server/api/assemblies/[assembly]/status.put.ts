import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq } from "drizzle-orm";
import type { AssemblyDto } from "~~/shared/types/api";
import { ASSEMBLY_STATUS_TRANSITIONS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { assemblyStatusBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import {
  ensureLiveState,
  loadAssemblyDto,
  readAssemblyBody,
  throwAssemblyMutationError,
} from "../../../utils/domain/assemblies";
import { recordEvent } from "../../../utils/domain/events";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { closeSpeakingTurns } from "../../../utils/domain/speakers";
import { buildOptimisticLockCondition } from "../../../utils/optimisticLock";

/** Moves the assembly along ASSEMBLY_STATUS_TRANSITIONS. */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, assemblyStatusBodySchema);

  if (!ASSEMBLY_STATUS_TRANSITIONS[assembly.status].includes(body.status)) {
    throw createError({
      statusCode: 409,
      message: "Ese cambio de estado no está permitido",
    });
  }

  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(assemblies)
        .set({ status: body.status })
        .where(
          and(
            eq(assemblies.id, assembly.id),
            eq(assemblies.status, assembly.status),
            buildOptimisticLockCondition(assemblies.updatedAt, body.updatedAt),
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

      if (body.status === "in_session") {
        await ensureLiveState(tx, assembly.id, actor.user.id);
      }
      // Nobody keeps the floor once the assembly closes: the turns could not
      // be ended afterwards (closed assemblies refuse speakers writes).
      if (body.status === "closed") {
        await closeSpeakingTurns(tx, assembly.id, actor);
      }

      await recordEvent(tx, {
        assemblyId: assembly.id,
        entityType: "assembly",
        entityId: assembly.id,
        type: "assembly_status_changed",
        payload: { from: assembly.status, to: body.status },
        actor,
      });
    });

    return await loadAssemblyDto(actor, assembly.id);
  } catch (error) {
    throwAssemblyMutationError("assemblies.status", error, event);
  }
});
