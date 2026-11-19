import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { eq } from "drizzle-orm";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { liveScrollBodySchema } from "~~/shared/utils/schemas/assembly";
import { db } from "../../../db";
import { liveState } from "../../../db/schema";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import { readAssemblyBody } from "../../../utils/domain/assemblies";
import { controlsProjection } from "../../../utils/domain/projectionControl";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { publishLiveScroll } from "../../../utils/live/scroll";

/**
 * The Mesa scrolls the document in debate: the projection follows
 * (server/utils/live/scroll.ts). Only for the document on screen and while
 * the session is open, and from the console that controls the projection;
 * anything else is ignored with a 204, since a late
 * position after the debate moved on is no mistake. Records nothing: it is
 * where a page is scrolled, not a change of the assembly.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, liveScrollBodySchema);
  setResponseStatus(event, 204);
  if (assembly.status !== "in_session") return null;
  if (!controlsProjection(event, assembly.id, actor)) return null;
  const [state] = await db
    .select({ documentId: liveState.documentId })
    .from(liveState)
    .where(eq(liveState.assemblyId, assembly.id));
  if (state?.documentId !== body.documentId) return null;
  publishLiveScroll(assembly.id, {
    documentId: body.documentId,
    anchor: body.anchor,
    at: new Date().toISOString(),
  });
  return null;
});
