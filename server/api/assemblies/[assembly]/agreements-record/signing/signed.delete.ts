import { defineEventHandler } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { requireRecordManager } from "../../../../../utils/domain/agreementsRecord";
import { removeSignedRecord } from "../../../../../utils/domain/agreementsSigning";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/** Withdraws the signed acta de acuerdos: the generated PDF stands again. */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireRecordManager(actor);
    try {
      return await removeSignedRecord(actor, assembly);
    } catch (error) {
      throwMutationError("agreementsRecord.unsign", error, event);
    }
  },
);
