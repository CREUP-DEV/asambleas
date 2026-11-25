import { defineEventHandler } from "h3";
import type { UserRef } from "~~/shared/types/api";
import { loadControlSheetActivityPeople } from "../../../../../utils/domain/activity";
import { requireControlSheetReader } from "../../../../../utils/domain/controlSheet";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/** Who recorded something the control sheet's «Historial» lists. */
export default defineEventHandler(async (event): Promise<UserRef[]> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  requireControlSheetReader(actor);
  return loadControlSheetActivityPeople(assembly.id);
});
