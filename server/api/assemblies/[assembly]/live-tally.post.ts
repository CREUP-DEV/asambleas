import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { liveTallyBodySchema } from "~~/shared/utils/schemas/assembly";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import {
  loadPublicItemMarks,
  readAssemblyBody,
} from "../../../utils/domain/assemblies";
import { controlsProjection } from "../../../utils/domain/projectionControl";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import {
  publishLiveTally,
  takeLiveTallyTicket,
} from "../../../utils/live/scroll";

/**
 * The Mesa announces a secret vote it is counting (user's decision of
 * 2026-11-19): what is voted, its question, whether the count is shown
 * ballot by ballot or only with the result, and the count so far; each
 * change goes to the projection (server/utils/live/scroll.ts); null ends
 * it. While the session is open; ending it, always. Only from the console
 * that controls the projection: any other is ignored with a 204, so
 * closing its form never clears the count on screen. Records nothing: the
 * vote is recorded as usual once counted.
 *
 * Everyone who reads the live stream gets it, so the question of an agenda
 * item's vote goes only when the public reads that item's title, as the
 * recorded vote's question does (toItemVoteDto).
 *
 * Pushes publish in the order they arrive (a ticket taken before anything
 * is awaited): a count still checking its item's title never lands after
 * the null that ended it. A count no console repeats ends on its own
 * (LIVE_TALLY_TTL_MS).
 */
export default defineEventHandler(async (event) => {
  const ticket = takeLiveTallyTicket();
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
  let tally = body.tally;
  if (tally?.question) {
    const itemId =
      tally.subject?.type === "agenda_item" ? tally.subject.id : null;
    const marks = itemId ? await loadPublicItemMarks(assembly.id) : null;
    const titlePublic =
      itemId !== null &&
      marks !== null &&
      !marks.unlisted.has(itemId) &&
      !marks.titleHidden.has(itemId);
    if (!titlePublic) tally = { ...tally, question: null };
  }
  publishLiveTally(
    assembly.id,
    { tally, at: new Date().toISOString() },
    ticket,
  );
  return null;
});
