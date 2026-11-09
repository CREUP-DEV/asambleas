import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import type { HeadcountsDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { headcountBodySchema } from "~~/shared/utils/schemas/headcount";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../utils/domain/assemblies";
import { recordHeadcount } from "../../../../utils/domain/headcounts";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../utils/errors";

/** The Mesa takes a headcount of the members with a vote. */
export default defineEventHandler(async (event): Promise<HeadcountsDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, headcountBodySchema);

  try {
    const headcounts = await recordHeadcount(actor, assembly, body);
    setResponseStatus(event, 201);
    return headcounts;
  } catch (error) {
    throwMutationError("headcounts.create", error, event);
  }
});
