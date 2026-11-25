import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingDeleteResultDto } from "~~/shared/types/api";
import { requireActor } from "../../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import {
  deleteSeatingPerson,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";

/**
 * Removes someone added by hand, or a seat without a name, from the room
 * (seating:edit).
 */
export default defineEventHandler(
  async (event): Promise<SeatingDeleteResultDto> => {
    const actor = await requireActor(event);
    requireSeatingEditor(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    try {
      return await deleteSeatingPerson(
        actor,
        assembly,
        getRouterParam(event, "person"),
      );
    } catch (error) {
      throwMutationError("seating.person", error, event);
    }
  },
);
