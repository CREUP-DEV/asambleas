import { defineEventHandler, getRouterParam } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { requireActor } from "../../../../../utils/domain/actor";
import { requireRecordManager } from "../../../../../utils/domain/agreementsRecord";
import { removeSignedRecord } from "../../../../../utils/domain/agreementsSigning";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../../utils/errors";

/** Withdraws the signed acta de acuerdos: the generated PDF stands again. */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const actor = await requireActor(event);
    requireRecordManager(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    try {
      return await removeSignedRecord(actor, assembly);
    } catch (error) {
      throwMutationError("agreementsRecord.unsign", error, event);
    }
  },
);
