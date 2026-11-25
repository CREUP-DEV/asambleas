import { readQueryWith } from "../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { ActivityPageDto } from "~~/shared/types/api";
import { controlSheetActivityQuerySchema } from "~~/shared/utils/schemas/activity";
import { loadControlSheetActivity } from "../../../../utils/domain/activity";
import { requireControlSheetReader } from "../../../../utils/domain/controlSheet";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * The control sheet's «Historial»: what changed in it or about it (its
 * notes, the presenters' answers, votes and decisions), newest first,
 * filtered and paged by `cursor`. Never with `?view=room`.
 */
export default defineEventHandler(async (event): Promise<ActivityPageDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  requireControlSheetReader(actor);
  const query = readQueryWith(event, controlSheetActivityQuerySchema);
  return loadControlSheetActivity(actor, assembly.id, query);
});
