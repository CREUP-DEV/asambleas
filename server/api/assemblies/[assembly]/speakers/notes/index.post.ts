import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import type { SpeakerNotesDto } from "~~/shared/types/api";
import { speakerNoteBodySchema } from "~~/shared/utils/schemas/speakers";
import { requireActor } from "../../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { noteSpeaker } from "../../../../../utils/domain/speakers";
import { throwMutationError } from "../../../../../utils/errors";

/** Notes that a member, or a person, spoke on an item or an amendment. */
export default defineEventHandler(async (event): Promise<SpeakerNotesDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, speakerNoteBodySchema);

  try {
    const notes = await noteSpeaker(actor, assembly, body);
    setResponseStatus(event, 201);
    return notes;
  } catch (error) {
    throwMutationError("speakers.note", error, event);
  }
});
