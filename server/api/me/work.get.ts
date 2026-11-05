import { defineEventHandler } from "h3";
import type { MeWorkDto } from "~~/shared/types/api";
import { requireActor } from "../../utils/domain/actor";
import { loadMeWork } from "../../utils/domain/review";

/** What the signed-in user has to do or is waiting for (home page). */
export default defineEventHandler(async (event): Promise<MeWorkDto> => {
  const actor = await requireActor(event);
  return loadMeWork(actor);
});
