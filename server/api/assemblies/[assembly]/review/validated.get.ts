import { defineEventHandler } from "h3";
import type { ReviewValidatedDto } from "~~/shared/types/api";
import { loadValidatedAmendments } from "../../../../utils/domain/review";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * «Publicadas» in the validation inbox (amendment:review): the amendments
 * validated and published that are still undecided, whose validation can
 * still be taken back.
 */
export default defineEventHandler(
  async (event): Promise<ReviewValidatedDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    return loadValidatedAmendments(actor, assembly);
  },
);
