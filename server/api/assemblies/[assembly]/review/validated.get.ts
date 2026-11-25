import { defineEventHandler, getRouterParam } from "h3";
import type { ReviewValidatedDto } from "~~/shared/types/api";
import { requireActor } from "../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { loadValidatedAmendments } from "../../../../utils/domain/review";

/**
 * «Publicadas» in the validation inbox (amendment:review): the amendments
 * validated and published that are still undecided, whose validation can
 * still be taken back.
 */
export default defineEventHandler(
  async (event): Promise<ReviewValidatedDto> => {
    const actor = await requireActor(event);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    return loadValidatedAmendments(actor, assembly);
  },
);
