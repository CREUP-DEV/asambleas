import { defineEventHandler, getRouterParam } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { requireActor } from "../../../../../utils/domain/actor";
import { requireRecordManager } from "../../../../../utils/domain/agreementsRecord";
import { prepareRecordForSigning } from "../../../../../utils/domain/agreementsSigning";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../../utils/errors";

/**
 * Makes the PDF of the approved acta de acuerdos to sign, with the visible
 * signature of the Secretaría Ejecutiva when the Intranet has one.
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const actor = await requireActor(event);
    requireRecordManager(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    try {
      return await prepareRecordForSigning(actor, assembly);
    } catch (error) {
      throwMutationError("agreementsRecord.prepare", error, event);
    }
  },
);
