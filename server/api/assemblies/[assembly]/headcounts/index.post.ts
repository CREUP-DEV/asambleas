import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, setResponseStatus } from "h3";
import type { HeadcountsDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { headcountBodySchema } from "~~/shared/utils/schemas/headcount";
import { requireCan } from "../../../../utils/domain/actor";
import { recordHeadcount } from "../../../../utils/domain/headcounts";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/** The Mesa takes a headcount of the members with a vote. */
export default defineEventHandler(async (event): Promise<HeadcountsDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const body = await readBodyWith(event, headcountBodySchema);

  try {
    const headcounts = await recordHeadcount(actor, assembly, body);
    setResponseStatus(event, 201);
    return headcounts;
  } catch (error) {
    throwMutationError("headcounts.create", error, event);
  }
});
