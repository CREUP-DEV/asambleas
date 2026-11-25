import { readQueryWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { ActivityPageDto } from "~~/shared/types/api";
import { controlSheetActivityQuerySchema } from "~~/shared/utils/schemas/activity";
import { loadControlSheetActivity } from "../../../../utils/domain/activity";
import { requireControlSheetReader } from "../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { requireViewer } from "../../../../utils/domain/roomView";

/**
 * The control sheet's «Historial»: what changed in it or about it (its
 * notes, the presenters' answers, votes and decisions), newest first,
 * filtered and paged by `cursor`. Never with `?view=room`.
 */
export default defineEventHandler(async (event): Promise<ActivityPageDto> => {
  const actor = await requireViewer(event);
  requireControlSheetReader(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const query = readQueryWith(event, controlSheetActivityQuerySchema);
  return loadControlSheetActivity(actor, assembly.id, query);
});
