import { defineEventHandler } from "h3";
import type { LiveTallyDto } from "~~/shared/types/api";
import { readLiveTally } from "../../../utils/live/scroll";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * The secret vote the Mesa is counting, for a projection that opens
 * mid-count; null when none is. Read as the room (requireViewer): the
 * running count the room sees anyway.
 */
export default defineEventHandler(
  async (event): Promise<LiveTallyDto | null> => {
    const { assembly } = await resolveAssemblyRoute(event, { viewer: true });
    return readLiveTally(assembly.id);
  },
);
