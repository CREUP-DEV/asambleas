import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingLayoutResultDto } from "~~/shared/types/api";
import { seatingLayoutBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import {
  requireSeatingEditor,
  saveSeatingLayout,
} from "../../../../utils/domain/seating";
import { throwMutationError } from "../../../../utils/errors";

/** Saves the room's layout (seating:edit), with its optimistic lock. */
export default defineEventHandler(
  async (event): Promise<SeatingLayoutResultDto> => {
    const actor = await requireActor(event);
    requireSeatingEditor(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const body = await readBodyWith(event, seatingLayoutBodySchema);
    try {
      return await saveSeatingLayout(actor, assembly, body);
    } catch (error) {
      throwMutationError("seating.layout", error, event);
    }
  },
);
