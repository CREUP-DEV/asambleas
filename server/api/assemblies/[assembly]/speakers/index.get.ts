import { defineEventHandler } from "h3";
import type { SpeakersDto } from "~~/shared/types/api";
import { loadSpeakers } from "../../../../utils/domain/speakers";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * Who has the floor and who is next. The Mesa gets the whole list of the
 * item in debate; attendees get it only while the Mesa makes it visible.
 */
export default defineEventHandler(async (event): Promise<SpeakersDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  return loadSpeakers(actor, assembly.id);
});
