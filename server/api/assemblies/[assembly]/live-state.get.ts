import { defineEventHandler, getRouterParam } from "h3";
import type { LiveStateDto } from "~~/shared/types/api";
import { requireActor } from "../../../utils/domain/actor";
import { loadLiveStateDto } from "../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/** What the Mesa is debating right now. All null before the session starts. */
export default defineEventHandler(async (event): Promise<LiveStateDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadLiveStateDto(assembly.id);
});
