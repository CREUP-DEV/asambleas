import { defineEventHandler, getRouterParam } from "h3";
import type { UserRef } from "~~/shared/types/api";
import { loadControlSheetActivityPeople } from "../../../../../utils/domain/activity";
import { requireControlSheetReader } from "../../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { requireViewer } from "../../../../../utils/domain/roomView";

/** Who recorded something the control sheet's «Historial» lists. */
export default defineEventHandler(async (event): Promise<UserRef[]> => {
  const actor = await requireViewer(event);
  requireControlSheetReader(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadControlSheetActivityPeople(assembly.id);
});
