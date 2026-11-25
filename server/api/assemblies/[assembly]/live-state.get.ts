import { defineEventHandler } from "h3";
import type { LiveStateDto } from "~~/shared/types/api";
import { liveStateFor } from "../../../utils/live/liveState";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * What the Mesa is debating right now. All null before the session starts.
 * The question of a point vote on screen goes only to a reader who gets
 * that item with its title (liveStateFor), as every other read of it.
 */
export default defineEventHandler(async (event): Promise<LiveStateDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  return liveStateFor(actor, assembly.id);
});
