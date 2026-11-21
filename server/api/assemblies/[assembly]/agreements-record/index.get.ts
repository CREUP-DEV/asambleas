import { defineEventHandler, getRouterParam } from "h3";
import type { AgreementsRecordDto } from "~~/shared/types/api";
import { requireActor } from "../../../../utils/domain/actor";
import {
  loadAgreementsRecordDto,
  requireRecordManager,
} from "../../../../utils/domain/agreementsRecord";
import { resolveAssembly } from "../../../../utils/domain/resolvers";

/**
 * The acta de acuerdos as it reads now, for the Secretaría
 * (document:manage): the record worded from the votes and its corrections,
 * and its document once created.
 */
export default defineEventHandler(
  async (event): Promise<AgreementsRecordDto> => {
    const actor = await requireActor(event);
    requireRecordManager(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    return loadAgreementsRecordDto(assembly);
  },
);
