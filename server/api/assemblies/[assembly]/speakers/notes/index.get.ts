import { defineEventHandler } from "h3";
import type { SpeakerNotesDto } from "~~/shared/types/api";
import { loadSpeakerNotes } from "../../../../../utils/domain/speakers";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * Every turn that spoke, with its item and amendment, for whoever notes the
 * speakers (the Mesa and session:record_speakers; 403 otherwise).
 */
export default defineEventHandler(async (event): Promise<SpeakerNotesDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  return loadSpeakerNotes(actor, assembly.id);
});
