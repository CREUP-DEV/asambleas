import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingSyncResultDto } from "~~/shared/types/api";
import { requireActor } from "../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import {
  requireSeatingEditor,
  syncSeating,
} from "../../../../utils/domain/seating";
import { throwMutationError } from "../../../../utils/errors";

/**
 * Reads the Intranet's attendees into the room (seating:edit), at most once
 * a minute whoever asks; the answer always carries the plan and how the
 * call went (`plan.sync.status`).
 */
export default defineEventHandler(
  async (event): Promise<SeatingSyncResultDto> => {
    const actor = await requireActor(event);
    requireSeatingEditor(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    try {
      return await syncSeating(actor, assembly);
    } catch (error) {
      throwMutationError("seating.sync", error, event);
    }
  },
);
