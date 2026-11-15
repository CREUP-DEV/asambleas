import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingSourceResultDto } from "~~/shared/types/api";
import { seatingSourceBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import {
  requireSeatingEditor,
  setSeatingSource,
} from "../../../../utils/domain/seating";
import { throwSeatingError } from "../../../../utils/seating/errors";

/**
 * Which assembly's Intranet attendees the room reads (seating:edit): another
 * one, or null for its own.
 */
export default defineEventHandler(
  async (event): Promise<SeatingSourceResultDto> => {
    const actor = await requireActor(event);
    requireSeatingEditor(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const body = await readAssemblyBody(event, seatingSourceBodySchema);
    try {
      return await setSeatingSource(actor, assembly, body);
    } catch (error) {
      throwSeatingError("seating.source", error, event);
    }
  },
);
