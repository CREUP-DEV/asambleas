import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { agreementsRecordCreateBodySchema } from "~~/shared/utils/schemas/agreementsRecord";
import { requireActor } from "../../../../utils/domain/actor";
import {
  createAgreementsRecord,
  requireRecordManager,
} from "../../../../utils/domain/agreementsRecord";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../utils/errors";

/**
 * Creates the acta de acuerdos under the agenda item where it is read and
 * voted, published at once. One per assembly (409).
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const actor = await requireActor(event);
    requireRecordManager(actor);
    const body = await readBodyWith(event, agreementsRecordCreateBodySchema);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    try {
      return await createAgreementsRecord(actor, assembly, body.agendaItemId);
    } catch (error) {
      throwMutationError("agreementsRecord.create", error, event);
    }
  },
);
