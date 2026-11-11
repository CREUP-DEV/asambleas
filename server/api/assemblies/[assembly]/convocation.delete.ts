import { defineEventHandler, getRouterParam } from "h3";
import type { AssemblyDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { convocationDeleteQuerySchema } from "~~/shared/utils/schemas/assembly";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import {
  loadAssemblyDto,
  readAssemblyQuery,
  throwAssemblyMutationError,
} from "../../../utils/domain/assemblies";
import { removeConvocationFile } from "../../../utils/domain/convocation";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/** Takes the signed convocatoria away; `?updatedAt=` of the assembly. */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const { updatedAt } = readAssemblyQuery(event, convocationDeleteQuerySchema);
  try {
    await removeConvocationFile(actor, assembly, updatedAt);
    return await loadAssemblyDto(actor, assembly.id);
  } catch (error) {
    throwAssemblyMutationError("assemblies.convocation.remove", error, event);
  }
});
