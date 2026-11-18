import { defineEventHandler, getRouterParam } from "h3";
import type { SessionProgressDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { loadSessionProgress } from "../../../utils/domain/sessionProgress";

/**
 * What the Mesa's console marks: the documents projected and the agenda
 * items treated. The Mesa only, never the room view.
 */
export default defineEventHandler(
  async (event): Promise<SessionProgressDto> => {
    const actor = await requireActor(event);
    requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    return loadSessionProgress(assembly.id);
  },
);
