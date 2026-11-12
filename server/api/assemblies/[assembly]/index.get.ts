import { defineEventHandler, getRouterParam } from "h3";
import type { AssemblyDto } from "~~/shared/types/api";
import { requireViewer } from "../../../utils/domain/roomView";
import { loadAssemblyDto } from "../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/** The assembly with its milestones, calendar warnings and capabilities. */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const actor = await requireViewer(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadAssemblyDto(actor, assembly);
});
