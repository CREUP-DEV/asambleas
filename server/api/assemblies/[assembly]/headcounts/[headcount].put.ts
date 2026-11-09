import { defineEventHandler, getRouterParam } from "h3";
import type { HeadcountsDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { headcountUpdateBodySchema } from "~~/shared/utils/schemas/headcount";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../utils/domain/assemblies";
import { updateHeadcount } from "../../../../utils/domain/headcounts";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../utils/errors";
import { validateCuid } from "../../../../utils/validation";

/** The Mesa corrects a headcount. */
export default defineEventHandler(async (event): Promise<HeadcountsDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const headcountId = validateCuid(
    getRouterParam(event, "headcount"),
    "Recuento",
  );
  const body = await readAssemblyBody(event, headcountUpdateBodySchema);

  try {
    return await updateHeadcount(actor, assembly, headcountId, body);
  } catch (error) {
    throwMutationError("headcounts.update", error, event);
  }
});
