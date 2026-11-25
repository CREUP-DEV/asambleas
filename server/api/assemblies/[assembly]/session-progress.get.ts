import { defineEventHandler } from "h3";
import type { SessionProgressDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireCan } from "../../../utils/domain/actor";
import { loadSessionProgress } from "../../../utils/domain/sessionProgress";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * What the Mesa's console marks: the documents projected and the agenda
 * items treated. The Mesa only, never the room view.
 */
export default defineEventHandler(
  async (event): Promise<SessionProgressDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
    return loadSessionProgress(assembly.id);
  },
);
