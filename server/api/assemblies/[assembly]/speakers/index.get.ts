import { defineEventHandler, getRouterParam } from "h3";
import type { SpeakersDto } from "~~/shared/types/api";
import { requireActor } from "../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { loadSpeakers } from "../../../../utils/domain/speakers";

/**
 * Who has the floor and who is next. The Mesa gets the whole list of the
 * item in debate; attendees get it only while the Mesa makes it visible.
 */
export default defineEventHandler(async (event): Promise<SpeakersDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadSpeakers(actor, assembly.id);
});
