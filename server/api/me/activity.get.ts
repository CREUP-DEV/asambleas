import { createError, defineEventHandler, getQuery } from "h3";
import type { MeActivityPageDto } from "~~/shared/types/api";
import { meActivityQuerySchema } from "~~/shared/utils/schemas/activity";
import { requireActor } from "../../utils/domain/actor";
import { loadMeActivity } from "../../utils/domain/activity";

/**
 * "Mi actividad": what the account did (`tab=by`), what was done to it
 * (`to`), its accesses (`access`) and what others did for its member
 * (`member`), newest first and paged by `cursor`. Every row is judged again
 * for the current account (docs/api.md, "Activity and impersonation").
 */
export default defineEventHandler(async (event): Promise<MeActivityPageDto> => {
  const actor = await requireActor(event);
  const parsed = meActivityQuerySchema.safeParse(getQuery(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Parámetros no válidos" });
  }
  return loadMeActivity(actor, parsed.data);
});
