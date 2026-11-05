import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import type { SpeakersDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { speakingTurnBodySchema } from "~~/shared/utils/schemas/speakers";
import { requireActor, requireCan } from "../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { addSpeakingTurn } from "../../../../utils/domain/speakers";
import { throwMutationError } from "../../../../utils/errors";

/** The Mesa writes down a request to speak at the end of the queue. */
export default defineEventHandler(async (event): Promise<SpeakersDto> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, speakingTurnBodySchema);

  try {
    const speakers = await addSpeakingTurn(actor, assembly, body);
    setResponseStatus(event, 201);
    return speakers;
  } catch (error) {
    throwMutationError("speakers.create", error, event);
  }
});
