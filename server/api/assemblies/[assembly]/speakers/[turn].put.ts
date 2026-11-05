import { defineEventHandler, getRouterParam } from "h3";
import type { SpeakersDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { speakingTurnUpdateBodySchema } from "~~/shared/utils/schemas/speakers";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { updateSpeakingTurn } from "../../../../utils/domain/speakers";
import { throwMutationError } from "../../../../utils/errors";
import { validateCuid } from "../../../../utils/validation";

/** The Mesa gives or ends the floor, cancels, restores or moves a turn. */
export default defineEventHandler(async (event): Promise<SpeakersDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const turnId = validateCuid(getRouterParam(event, "turn"), "Turno");
  const body = await readAssemblyBody(event, speakingTurnUpdateBodySchema);

  try {
    return await updateSpeakingTurn(actor, assembly, turnId, body);
  } catch (error) {
    throwMutationError("speakers.update", error, event);
  }
});
