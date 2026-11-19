import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { liveTallyBodySchema } from "~~/shared/utils/schemas/assembly";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import { readAssemblyBody } from "../../../utils/domain/assemblies";
import { controlsProjection } from "../../../utils/domain/projectionControl";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { publishLiveTally } from "../../../utils/live/scroll";

/**
 * The Mesa counts a secret vote ballot by ballot: each change of the count
 * goes to the projection (server/utils/live/scroll.ts); null ends it.
 * While the session is open; ending it, always. Only from the console that
 * controls the projection: any other is ignored with a 204, so closing its
 * form never clears the count on screen. Records nothing: the vote is
 * recorded as usual once counted.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, liveTallyBodySchema);
  setResponseStatus(event, 204);
  if (body.tally && assembly.status !== "in_session") return null;
  if (!controlsProjection(event, assembly.id, actor)) return null;
  publishLiveTally(assembly.id, {
    tally: body.tally,
    at: new Date().toISOString(),
  });
  return null;
});
