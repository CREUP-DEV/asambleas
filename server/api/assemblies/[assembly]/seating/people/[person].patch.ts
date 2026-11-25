import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingPersonResultDto } from "~~/shared/types/api";
import { seatingPersonUpdateBodySchema } from "~~/shared/utils/schemas/seating";
import {
  requireSeatingEditor,
  updateSeatingPerson,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/** Changes a person of the room (seating:edit), with its optimistic lock. */
export default defineEventHandler(
  async (event): Promise<SeatingPersonResultDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireSeatingEditor(actor);
    const body = await readBodyWith(event, seatingPersonUpdateBodySchema);
    try {
      return await updateSeatingPerson(
        actor,
        assembly,
        getRouterParam(event, "person"),
        body,
      );
    } catch (error) {
      throwMutationError("seating.person", error, event);
    }
  },
);
