import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingDeleteResultDto } from "~~/shared/types/api";
import {
  deleteSeatingGroup,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/** Removes a group made by hand and its people (seating:edit). */
export default defineEventHandler(
  async (event): Promise<SeatingDeleteResultDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireSeatingEditor(actor);
    try {
      return await deleteSeatingGroup(
        actor,
        assembly,
        getRouterParam(event, "group"),
      );
    } catch (error) {
      throwMutationError("seating.group", error, event);
    }
  },
);
