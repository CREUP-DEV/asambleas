import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { SpeakersDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { speakingTurnUpdateBodySchema } from "~~/shared/utils/schemas/speakers";
import { requireCan } from "../../../../utils/domain/actor";
import { updateSpeakingTurn } from "../../../../utils/domain/speakers";
import { throwMutationError } from "../../../../utils/errors";
import { validateCuid } from "../../../../utils/validation";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/** The Mesa gives or ends the floor, cancels, restores or moves a turn. */
export default defineEventHandler(async (event): Promise<SpeakersDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const turnId = validateCuid(getRouterParam(event, "turn"), "Turno");
  const body = await readBodyWith(event, speakingTurnUpdateBodySchema);

  try {
    return await updateSpeakingTurn(actor, assembly, turnId, body);
  } catch (error) {
    throwMutationError("speakers.update", error, event);
  }
});
