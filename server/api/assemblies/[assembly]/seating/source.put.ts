import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { SeatingSourceResultDto } from "~~/shared/types/api";
import { seatingSourceBodySchema } from "~~/shared/utils/schemas/seating";
import {
  requireSeatingEditor,
  setSeatingSource,
} from "../../../../utils/domain/seating";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * Which assembly's Intranet attendees the room reads (seating:edit): another
 * one, or null for its own.
 */
export default defineEventHandler(
  async (event): Promise<SeatingSourceResultDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireSeatingEditor(actor);
    const body = await readBodyWith(event, seatingSourceBodySchema);
    try {
      return await setSeatingSource(actor, assembly, body);
    } catch (error) {
      throwMutationError("seating.source", error, event);
    }
  },
);
