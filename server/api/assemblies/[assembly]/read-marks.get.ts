import { defineEventHandler, getRouterParam } from "h3";
import type { ReadMarksDto } from "~~/shared/types/api";
import { requireActor } from "../../../utils/domain/actor";
import { loadReadMarks } from "../../../utils/domain/readMarks";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/**
 * What the account marked as read among the published documents of the
 * assembly and their published amendments, and what changed since.
 */
export default defineEventHandler(async (event): Promise<ReadMarksDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadReadMarks(actor, assembly);
});
