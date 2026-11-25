import { defineEventHandler } from "h3";
import type { ReadMarksDto } from "~~/shared/types/api";
import { loadReadMarks } from "../../../utils/domain/readMarks";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * What the account marked as read among the published documents of the
 * assembly and their published amendments, and what changed since.
 */
export default defineEventHandler(async (event): Promise<ReadMarksDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  return loadReadMarks(actor, assembly);
});
