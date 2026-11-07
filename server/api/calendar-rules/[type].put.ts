import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { z } from "zod/v4";
import {
  ALL_ASSEMBLY_TYPES,
  type AssemblyType,
} from "~~/shared/constants/assemblyTypes";
import { CALENDAR_RULES_PERMISSION } from "~~/shared/constants/calendarRules";
import type { CalendarRulesDto } from "~~/shared/types/api";
import { calendarRulesBodySchema } from "~~/shared/utils/schemas/calendarRules";
import { requireActor, requireCan } from "../../utils/domain/actor";
import { updateCalendarRules } from "../../utils/domain/calendarRules";

const typeSchema = z.enum(
  ALL_ASSEMBLY_TYPES as [AssemblyType, ...AssemblyType[]],
);

/**
 * Replaces the calendar rules of an assembly type
 * (CALENDAR_RULES_PERMISSION), with optimistic locking on `updatedAt`.
 * Audit `calendar_rules.update`. Existing calendars keep their dates.
 */
export default defineEventHandler(async (event): Promise<CalendarRulesDto> => {
  const actor = await requireActor(event);
  requireCan(actor, CALENDAR_RULES_PERMISSION);

  const type = typeSchema.safeParse(getRouterParam(event, "type"));
  if (!type.success) {
    throw createError({
      statusCode: 404,
      message: "Tipo de asamblea no encontrado",
    });
  }
  const body = calendarRulesBodySchema.safeParse(await readBody(event));
  if (!body.success) {
    throw createError({
      statusCode: 400,
      message: "Reglas del calendario no válidas",
    });
  }
  return updateCalendarRules({
    event,
    actor,
    type: type.data,
    rules: body.data.rules,
    updatedAt: body.data.updatedAt,
  });
});
