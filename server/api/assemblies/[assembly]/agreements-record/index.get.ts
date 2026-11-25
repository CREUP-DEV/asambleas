import { defineEventHandler } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import {
  loadAgreementsRecordDto,
  requireRecordManager,
} from "../../../../utils/domain/agreementsRecord";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * The acta de acuerdos as it reads now, for the Secretaría
 * (document:manage): the record worded from the votes and its corrections,
 * and its document once created.
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireRecordManager(actor);
    return loadAgreementsRecordDto(assembly);
  },
);
