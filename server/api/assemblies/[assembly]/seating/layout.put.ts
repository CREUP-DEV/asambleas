import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { SeatingLayoutResultDto } from "~~/shared/types/api";
import { seatingLayoutBodySchema } from "~~/shared/utils/schemas/seating";
import {
  requireSeatingEditor,
  saveSeatingLayout,
} from "../../../../utils/domain/seating";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/** Saves the room's layout (seating:edit), with its optimistic lock. */
export default defineEventHandler(
  async (event): Promise<SeatingLayoutResultDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireSeatingEditor(actor);
    const body = await readBodyWith(event, seatingLayoutBodySchema);
    try {
      return await saveSeatingLayout(actor, assembly, body);
    } catch (error) {
      throwMutationError("seating.layout", error, event);
    }
  },
);
