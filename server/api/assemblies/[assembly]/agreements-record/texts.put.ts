import { defineEventHandler, getRouterParam } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { agreementRecordTextBodySchema } from "~~/shared/utils/schemas/agreementsRecord";
import { requireActor } from "../../../../utils/domain/actor";
import {
  requireRecordManager,
  saveAgreementRecordText,
} from "../../../../utils/domain/agreementsRecord";
import { readAssemblyBody } from "../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../utils/errors";

/**
 * Saves one of the Secretaría's corrections to the acta de acuerdos (its
 * words for a line, or that the line is left out) and writes the record
 * again at once.
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const actor = await requireActor(event);
    requireRecordManager(actor);
    const body = await readAssemblyBody(event, agreementRecordTextBodySchema);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    try {
      return await saveAgreementRecordText(actor, assembly, body);
    } catch (error) {
      throwMutationError("agreementsRecord.text", error, event);
    }
  },
);
