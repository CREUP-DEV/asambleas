import { defineEventHandler, getRouterParam } from "h3";
import type { SpeakerNotesDto } from "~~/shared/types/api";
import { requireActor } from "../../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { removeSpeakerNote } from "../../../../../utils/domain/speakers";
import { throwMutationError } from "../../../../../utils/errors";
import { validateCuid } from "../../../../../utils/validation";

/** Takes back a note of who spoke (never a turn given from the queue). */
export default defineEventHandler(async (event): Promise<SpeakerNotesDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const turnId = validateCuid(getRouterParam(event, "turn"), "Intervención");

  try {
    return await removeSpeakerNote(actor, assembly, turnId);
  } catch (error) {
    throwMutationError("speakers.unnote", error, event);
  }
});
