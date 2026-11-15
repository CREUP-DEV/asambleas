import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingPersonResultDto } from "~~/shared/types/api";
import { seatingPersonUpdateBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import {
  requireSeatingEditor,
  updateSeatingPerson,
} from "../../../../../utils/domain/seating";
import { throwSeatingError } from "../../../../../utils/seating/errors";

/** Changes a person of the room (seating:edit), with its optimistic lock. */
export default defineEventHandler(
  async (event): Promise<SeatingPersonResultDto> => {
    const actor = await requireActor(event);
    requireSeatingEditor(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const body = await readAssemblyBody(event, seatingPersonUpdateBodySchema);
    try {
      return await updateSeatingPerson(
        actor,
        assembly,
        getRouterParam(event, "person"),
        body,
      );
    } catch (error) {
      throwSeatingError("seating.person", error, event);
    }
  },
);
