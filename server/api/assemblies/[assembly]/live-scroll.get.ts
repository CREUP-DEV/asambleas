import { defineEventHandler, getRouterParam } from "h3";
import { eq } from "drizzle-orm";
import type { LiveScrollDto } from "~~/shared/types/api";
import { db } from "../../../db";
import { liveState } from "../../../db/schema";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { requireViewer } from "../../../utils/domain/roomView";
import { readLiveScroll } from "../../../utils/live/scroll";

/**
 * Where the Mesa last had the document in debate scrolled, for a
 * projection that opens or moves to it; null when it never scrolled it.
 * Read as the room (requireViewer): a position in the document the room
 * already sees, nothing else.
 */
export default defineEventHandler(
  async (event): Promise<LiveScrollDto | null> => {
    const actor = await requireViewer(event);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const scroll = readLiveScroll(assembly.id);
    if (!scroll) return null;
    const [state] = await db
      .select({ documentId: liveState.documentId })
      .from(liveState)
      .where(eq(liveState.assemblyId, assembly.id));
    return state?.documentId === scroll.documentId ? scroll : null;
  },
);
