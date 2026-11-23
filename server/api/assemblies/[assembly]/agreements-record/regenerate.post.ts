import { defineEventHandler, getRouterParam } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { requireActor } from "../../../../utils/domain/actor";
import {
  regenerateApprovedRecord,
  requireRecordManager,
} from "../../../../utils/domain/agreementsRecord";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../utils/errors";

/**
 * Writes the approved acta de acuerdos again with the Secretaría's
 * corrections, as a new version; its signed PDF goes, to be signed again.
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
      return await regenerateApprovedRecord(actor, assembly);
    } catch (error) {
      throwMutationError("agreementsRecord.regenerate", error, event);
    }
  },
);
