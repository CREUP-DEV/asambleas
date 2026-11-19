import { defineEventHandler, getRouterParam } from "h3";
import type { SpeakerNotesDto } from "~~/shared/types/api";
import { requireActor } from "../../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { loadSpeakerNotes } from "../../../../../utils/domain/speakers";

/**
 * Every turn that spoke, with its item and amendment, for whoever notes the
 * speakers (the Mesa and session:record_speakers; 403 otherwise).
 */
export default defineEventHandler(async (event): Promise<SpeakerNotesDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadSpeakerNotes(actor, assembly.id);
});
