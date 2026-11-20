import { defineEventHandler, getRouterParam } from "h3";
import type { LiveStateDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { liveStateBodySchema } from "~~/shared/utils/schemas/assembly";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import {
  readAssemblyBody,
  throwAssemblyMutationError,
  updateLiveState,
} from "../../../utils/domain/assemblies";
import { controlsProjection } from "../../../utils/domain/projectionControl";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { liveStateFor } from "../../../utils/live/liveState";

/**
 * The Mesa points the session at an agenda item, document, amendment or
 * vote (only the console that controls the projection), or sets the
 * message, the recess, the speakers' visibility or the default limit.
 */
export default defineEventHandler(async (event): Promise<LiveStateDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, liveStateBodySchema);

  let state: LiveStateDto;
  try {
    state = await updateLiveState(actor, assembly.id, body, {
      controlsProjection: controlsProjection(event, assembly.id, actor),
    });
  } catch (error) {
    throwAssemblyMutationError("assemblies.liveState", error, event);
  }
  // Answered as its GET answers this account (a point vote's question).
  return liveStateFor(actor, assembly.id, state);
});
