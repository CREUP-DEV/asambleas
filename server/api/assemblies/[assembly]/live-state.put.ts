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
import { resolveAssembly } from "../../../utils/domain/resolvers";

/** The Mesa points the session at an agenda item, document, amendment or vote. */
export default defineEventHandler(async (event): Promise<LiveStateDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, liveStateBodySchema);

  try {
    return await updateLiveState(actor, assembly.id, body);
  } catch (error) {
    throwAssemblyMutationError("assemblies.liveState", error, event);
  }
});
