import { defineEventHandler } from "h3";
import type { DecisionDto } from "~~/shared/types/api";
import { loadDecisionDtos } from "../../../utils/domain/assemblies";
import { filterVisibleDecisions } from "../../../utils/domain/documents";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * Procedural decisions of the assembly, oldest first. Admission decisions
 * only name the amendments the actor may see (an amendment is public once
 * the Secretaría publishes it).
 */
export default defineEventHandler(async (event): Promise<DecisionDto[]> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  return filterVisibleDecisions(
    actor,
    assembly,
    await loadDecisionDtos(assembly.id),
  );
});
