import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, setResponseStatus } from "h3";
import type { SpeakerNotesDto } from "~~/shared/types/api";
import { speakerNoteBodySchema } from "~~/shared/utils/schemas/speakers";
import { noteSpeaker } from "../../../../../utils/domain/speakers";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/** Notes that a member, or a person, spoke on an item or an amendment. */
export default defineEventHandler(async (event): Promise<SpeakerNotesDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  const body = await readBodyWith(event, speakerNoteBodySchema);

  try {
    const notes = await noteSpeaker(actor, assembly, body);
    setResponseStatus(event, 201);
    return notes;
  } catch (error) {
    throwMutationError("speakers.note", error, event);
  }
});
