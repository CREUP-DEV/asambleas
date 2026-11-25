import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingDeleteResultDto } from "~~/shared/types/api";
import {
  deleteSeatingPerson,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * Removes someone added by hand, or a seat without a name, from the room
 * (seating:edit).
 */
export default defineEventHandler(
  async (event): Promise<SeatingDeleteResultDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireSeatingEditor(actor);
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
