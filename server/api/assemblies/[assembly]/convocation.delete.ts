import { readQueryWith } from "../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AssemblyDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { convocationDeleteQuerySchema } from "~~/shared/utils/schemas/assembly";
import { requireCan } from "../../../utils/domain/actor";
import {
  loadAssemblyDto,
  throwAssemblyMutationError,
} from "../../../utils/domain/assemblies";
import { removeConvocationFile } from "../../../utils/domain/convocation";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/** Takes the signed convocatoria away; `?updatedAt=` of the assembly. */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const { updatedAt } = readQueryWith(event, convocationDeleteQuerySchema);
  try {
    await removeConvocationFile(actor, assembly, updatedAt);
    return await loadAssemblyDto(actor, assembly.id);
  } catch (error) {
    throwAssemblyMutationError("assemblies.convocation.remove", error, event);
  }
});
