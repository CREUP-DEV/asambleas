import { defineEventHandler, getRouterParam } from "h3";
import type { AssemblyDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import {
  loadAssemblyDto,
  throwAssemblyMutationError,
} from "../../../utils/domain/assemblies";
import { attachConvocationFile } from "../../../utils/domain/convocation";
import {
  PDF_MAX_BYTES,
  readUploadedFile,
} from "../../../utils/domain/documents";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/**
 * The signed convocatoria as a PDF: multipart `file` (up to 20 MB) and
 * `updatedAt` of the assembly. Replaces the one uploaded before.
 */
export default defineEventHandler(async (event): Promise<AssemblyDto> => {
  const actor = await requireActor(event);
  // Refuse before reading a large body the actor may not upload.
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const file = await readUploadedFile(
    event,
    PDF_MAX_BYTES,
    "El archivo supera el límite de 20 MB",
  );
  try {
    await attachConvocationFile(actor, assembly, file);
    return await loadAssemblyDto(actor, assembly.id);
  } catch (error) {
    throwAssemblyMutationError("assemblies.convocation.upload", error, event);
  }
});
