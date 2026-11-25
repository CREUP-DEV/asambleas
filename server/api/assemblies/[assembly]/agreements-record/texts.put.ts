import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { agreementRecordTextBodySchema } from "~~/shared/utils/schemas/agreementsRecord";
import {
  requireRecordManager,
  saveAgreementRecordText,
} from "../../../../utils/domain/agreementsRecord";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * Saves one of the Secretaría's corrections to the acta de acuerdos (its
 * words for a line, or that the line is left out) and writes the record
 * again at once.
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireRecordManager(actor);
    const body = await readBodyWith(event, agreementRecordTextBodySchema);
    try {
      return await saveAgreementRecordText(actor, assembly, body);
    } catch (error) {
      throwMutationError("agreementsRecord.text", error, event);
    }
  },
);
