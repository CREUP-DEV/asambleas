import { createError, defineEventHandler, setResponseStatus } from "h3";
import type { AssemblyDto } from "~~/shared/types/api";
import { DEFAULT_ASSEMBLY_SETTINGS } from "~~/shared/constants/domain";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { defaultMilestones } from "~~/shared/utils/calendar";
import { assemblyCreateBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../db";
import { assemblies } from "../../db/schema";
import { requireActor, requireCan } from "../../utils/domain/actor";
import {
  findAssemblyByTypeNumber,
  insertMilestones,
  loadAssemblyDto,
  readAssemblyBody,
  throwAssemblyMutationError,
} from "../../utils/domain/assemblies";
import { loadCalendarRules } from "../../utils/domain/calendarRules";
import { recordEvent } from "../../utils/domain/events";

/**
 * Creates a draft assembly and, unless told not to, its default calendar
 * from the calendar rules of its type.
 */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_CREATE);
  const body = await readAssemblyBody(event, assemblyCreateBodySchema);

  const startDate = new Date(body.startDate);
  const endDate = new Date(body.endDate);

  try {
    const assemblyId = await db.transaction(async (tx) => {
      if (await findAssemblyByTypeNumber(body.type, body.number, tx)) {
        throw createError({
          statusCode: 409,
          message: "Ya existe una asamblea de ese tipo con ese número",
        });
      }

      const [created] = await tx
        .insert(assemblies)
        .values({
          number: body.number,
          type: body.type,
          status: "draft",
          startDate,
          endDate,
          location: body.location,
          settings: { ...DEFAULT_ASSEMBLY_SETTINGS },
        })
        .returning({ id: assemblies.id });
      if (!created) {
        throw createError({
          statusCode: 500,
          message: "No se pudo crear la asamblea",
        });
      }

      const applyDefaults = body.applyDefaultCalendar !== false;
      if (applyDefaults) {
        await insertMilestones(
          tx,
          created.id,
          defaultMilestones(await loadCalendarRules(body.type, tx), startDate),
        );
      }

      await recordEvent(tx, {
        assemblyId: created.id,
        entityType: "assembly",
        entityId: created.id,
        type: "assembly_created",
        payload: {
          number: body.number,
          type: body.type,
          defaultCalendar: applyDefaults,
        },
        actor,
      });
      return created.id;
    });

    setResponseStatus(event, 201);
    return await loadAssemblyDto(actor, assemblyId);
  } catch (error) {
    throwAssemblyMutationError("assemblies.create", error, event);
  }
});
