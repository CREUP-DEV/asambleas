import { defineEventHandler, getRouterParam } from "h3";
import type { DecisionDto } from "~~/shared/types/api";
import { requireActor } from "../../../utils/domain/actor";
import { loadDecisionDtos } from "../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/** Procedural decisions of the assembly, oldest first. */
export default defineEventHandler(async (event): Promise<DecisionDto[]> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadDecisionDtos(assembly.id);
});
