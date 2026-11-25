import { defineEventHandler } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import {
  regenerateApprovedRecord,
  requireRecordManager,
} from "../../../../utils/domain/agreementsRecord";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * Writes the approved acta de acuerdos again with the Secretaría's
 * corrections, as a new version; its signed PDF goes, to be signed again.
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireRecordManager(actor);
    try {
      return await regenerateApprovedRecord(actor, assembly);
    } catch (error) {
      throwMutationError("agreementsRecord.regenerate", error, event);
    }
  },
);
