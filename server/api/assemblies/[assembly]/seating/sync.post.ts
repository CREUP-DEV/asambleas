import { defineEventHandler } from "h3";
import type { SeatingSyncResultDto } from "~~/shared/types/api";
import {
  requireSeatingEditor,
  syncSeating,
} from "../../../../utils/domain/seating";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * Reads the Intranet's attendees into the room (seating:edit), at most once
 * a minute whoever asks; the answer always carries the plan and how the
 * call went (`plan.sync.status`).
 */
export default defineEventHandler(
  async (event): Promise<SeatingSyncResultDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireSeatingEditor(actor);
    try {
      return await syncSeating(actor, assembly);
    } catch (error) {
      throwMutationError("seating.sync", error, event);
    }
  },
);
