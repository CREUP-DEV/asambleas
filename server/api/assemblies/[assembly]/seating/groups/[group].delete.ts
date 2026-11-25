import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingDeleteResultDto } from "~~/shared/types/api";
import { requireActor } from "../../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import {
  deleteSeatingGroup,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";

/** Removes a group made by hand and its people (seating:edit). */
export default defineEventHandler(
  async (event): Promise<SeatingDeleteResultDto> => {
    const actor = await requireActor(event);
    requireSeatingEditor(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
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
