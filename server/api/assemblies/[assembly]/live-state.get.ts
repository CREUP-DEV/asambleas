import { defineEventHandler, getRouterParam } from "h3";
import type { LiveStateDto } from "~~/shared/types/api";
import { requireViewer } from "../../../utils/domain/roomView";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { liveStateFor } from "../../../utils/live/liveState";

/**
 * What the Mesa is debating right now. All null before the session starts.
 * The question of a point vote on screen goes only to a reader who gets
 * that item with its title (liveStateFor), as every other read of it.
 */
export default defineEventHandler(async (event): Promise<LiveStateDto> => {
  const actor = await requireViewer(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return liveStateFor(actor, assembly.id);
});
