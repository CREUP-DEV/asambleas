import { defineEventHandler } from "h3";
import type { AssemblyDto } from "~~/shared/types/api";
import { loadAssemblyDto } from "../../../utils/domain/assemblies";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/** The assembly with its milestones, calendar warnings and capabilities. */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  return loadAssemblyDto(actor, assembly);
});
