import { defineEventHandler } from "h3";
import type { HeadcountsDto } from "~~/shared/types/api";
import { loadHeadcounts } from "../../../../utils/domain/headcounts";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * The Mesa's headcounts, newest first, and what a new one is checked
 * against. Public to everyone who sees the assembly; the members a new
 * count lists only reach the Mesa.
 */
export default defineEventHandler(async (event): Promise<HeadcountsDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  return loadHeadcounts(actor, assembly);
});
