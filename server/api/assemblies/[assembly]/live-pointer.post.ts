import { readBodyWith } from "../../../utils/core/http";
import { defineEventHandler, setResponseStatus } from "h3";
import { eq } from "drizzle-orm";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { livePointerBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../db";
import { liveState } from "../../../db/schema";
import { requireCan } from "../../../utils/domain/actor";
import { controlsProjection } from "../../../utils/domain/projectionControl";
import { publishLivePointer } from "../../../utils/live/scroll";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * The Mesa points or draws on the document in debate: the projection shows
 * the pointer, the ripples of a click and the strokes (server/utils/live/
 * scroll.ts). Only for the document on screen, while the session is open
 * and from the console that controls the projection; anything else is
 * ignored with a 204. Records and keeps nothing.
 */
export default defineEventHandler(async (event) => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const body = await readBodyWith(event, livePointerBodySchema);
  setResponseStatus(event, 204);
  if (assembly.status !== "in_session") return null;
  if (!controlsProjection(event, assembly.id, actor)) return null;
  const [state] = await db
    .select({ documentId: liveState.documentId })
    .from(liveState)
    .where(eq(liveState.assemblyId, assembly.id));
  if (state?.documentId !== body.documentId) return null;
  publishLivePointer(assembly.id, {
    documentId: body.documentId,
    events: body.events,
    at: new Date().toISOString(),
  });
  return null;
});
