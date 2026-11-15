import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingLayoutResultDto } from "~~/shared/types/api";
import { seatingLayoutBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import {
  requireSeatingEditor,
  saveSeatingLayout,
} from "../../../../utils/domain/seating";
import { throwSeatingError } from "../../../../utils/seating/errors";

/** Saves the room's layout (seating:edit), with its optimistic lock. */
export default defineEventHandler(
  async (event): Promise<SeatingLayoutResultDto> => {
    const actor = await requireActor(event);
    requireSeatingEditor(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const body = await readAssemblyBody(event, seatingLayoutBodySchema);
    try {
      return await saveSeatingLayout(actor, assembly, body);
    } catch (error) {
      throwSeatingError("seating.layout", error, event);
    }
  },
);
