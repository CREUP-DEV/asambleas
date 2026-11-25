import { defineEventHandler } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { requireRecordManager } from "../../../../../utils/domain/agreementsRecord";
import { prepareRecordForSigning } from "../../../../../utils/domain/agreementsSigning";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * Makes the PDF of the approved acta de acuerdos to sign, with the visible
 * signature of the Secretaría Ejecutiva when the Intranet has one.
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireRecordManager(actor);
    try {
      return await prepareRecordForSigning(actor, assembly);
    } catch (error) {
      throwMutationError("agreementsRecord.prepare", error, event);
    }
  },
);
