import { defineEventHandler, getRouterParam } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { requireActor } from "../../../../../utils/domain/actor";
import { requireRecordManager } from "../../../../../utils/domain/agreementsRecord";
import { attachSignedRecord } from "../../../../../utils/domain/agreementsSigning";
import {
  PDF_MAX_BYTES,
  readUploadedFile,
} from "../../../../../utils/domain/documents";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../../utils/errors";

/**
 * The signed acta de acuerdos as a PDF: multipart `file` (up to 20 MB, with
 * a digital signature) and `updatedAt` of its signing. Published at once,
 * replacing the one signed before.
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const actor = await requireActor(event);
    // Refuse before reading a large body the actor may not upload.
    requireRecordManager(actor);
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
      return await attachSignedRecord(actor, assembly, file);
    } catch (error) {
      throwMutationError("agreementsRecord.sign", error, event);
    }
  },
);
