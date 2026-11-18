import { defineEventHandler, getRouterParam } from "h3";
import type { LiveTallyDto } from "~~/shared/types/api";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { requireViewer } from "../../../utils/domain/roomView";
import { readLiveTally } from "../../../utils/live/scroll";

/**
 * The secret vote the Mesa is counting, for a projection that opens
 * mid-count; null when none is. Read as the room (requireViewer): the
 * running count the room sees anyway.
 */
export default defineEventHandler(
  async (event): Promise<LiveTallyDto | null> => {
    const actor = await requireViewer(event);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    return readLiveTally(assembly.id);
  },
);
