import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { HeadcountsDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { headcountUpdateBodySchema } from "~~/shared/utils/schemas/headcount";
import { requireCan } from "../../../../utils/domain/actor";
import { updateHeadcount } from "../../../../utils/domain/headcounts";
import { throwMutationError } from "../../../../utils/errors";
import { validateCuid } from "../../../../utils/validation";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/** The Mesa corrects a headcount. */
export default defineEventHandler(async (event): Promise<HeadcountsDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const headcountId = validateCuid(
    getRouterParam(event, "headcount"),
    "Recuento",
  );
  const body = await readBodyWith(event, headcountUpdateBodySchema);

  try {
    return await updateHeadcount(actor, assembly, headcountId, body);
  } catch (error) {
    throwMutationError("headcounts.update", error, event);
  }
});
