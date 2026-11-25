import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingAssignmentsResultDto } from "~~/shared/types/api";
import { seatingAssignmentsBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import {
  applySeatingAssignments,
  requireSeatingEditor,
} from "../../../../utils/domain/seating";
import { throwMutationError } from "../../../../utils/errors";

/** Changes who sits where (seating:edit): up to 600 seats, all or none. */
export default defineEventHandler(
  async (event): Promise<SeatingAssignmentsResultDto> => {
    const actor = await requireActor(event);
    requireSeatingEditor(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const body = await readBodyWith(event, seatingAssignmentsBodySchema);
    try {
      return await applySeatingAssignments(actor, assembly, body);
    } catch (error) {
      throwMutationError("seating.assignments", error, event);
    }
  },
);
