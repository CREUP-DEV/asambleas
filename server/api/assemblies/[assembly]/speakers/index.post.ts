import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, setResponseStatus } from "h3";
import type { SpeakersDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { speakingTurnBodySchema } from "~~/shared/utils/schemas/speakers";
import { requireCan } from "../../../../utils/domain/actor";
import { addSpeakingTurn } from "../../../../utils/domain/speakers";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/** The Mesa writes down a request to speak at the end of the queue. */
export default defineEventHandler(async (event): Promise<SpeakersDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const body = await readBodyWith(event, speakingTurnBodySchema);

  try {
    const speakers = await addSpeakingTurn(actor, assembly, body);
    setResponseStatus(event, 201);
    return speakers;
  } catch (error) {
    throwMutationError("speakers.create", error, event);
  }
});
