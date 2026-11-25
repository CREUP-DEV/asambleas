import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { agreementsRecordCreateBodySchema } from "~~/shared/utils/schemas/agreementsRecord";
import {
  createAgreementsRecord,
  requireRecordManager,
} from "../../../../utils/domain/agreementsRecord";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * Creates the acta de acuerdos under the agenda item where it is read and
 * voted, published at once. One per assembly (409).
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireRecordManager(actor);
    const body = await readBodyWith(event, agreementsRecordCreateBodySchema);
    try {
      return await createAgreementsRecord(actor, assembly, body.agendaItemId);
    } catch (error) {
      throwMutationError("agreementsRecord.create", error, event);
    }
  },
);
