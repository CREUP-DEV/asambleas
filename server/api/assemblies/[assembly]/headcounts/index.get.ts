import { defineEventHandler, getRouterParam } from "h3";
import type { HeadcountsDto } from "~~/shared/types/api";
import { requireActor } from "../../../../utils/domain/actor";
import { loadHeadcounts } from "../../../../utils/domain/headcounts";
import { resolveAssembly } from "../../../../utils/domain/resolvers";

/**
 * The Mesa's headcounts, newest first, and what a new one is checked
 * against. Public to everyone who sees the assembly; the members a new
 * count lists only reach the Mesa.
 */
export default defineEventHandler(async (event): Promise<HeadcountsDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadHeadcounts(actor, assembly);
});
