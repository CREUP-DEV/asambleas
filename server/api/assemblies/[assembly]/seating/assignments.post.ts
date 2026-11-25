import { readBodyWith } from "../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { SeatingAssignmentsResultDto } from "~~/shared/types/api";
import { seatingAssignmentsBodySchema } from "~~/shared/utils/schemas/seating";
import {
  applySeatingAssignments,
  requireSeatingEditor,
} from "../../../../utils/domain/seating";
import { throwMutationError } from "../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/** Changes who sits where (seating:edit): up to 600 seats, all or none. */
export default defineEventHandler(
  async (event): Promise<SeatingAssignmentsResultDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireSeatingEditor(actor);
    const body = await readBodyWith(event, seatingAssignmentsBodySchema);
    try {
      return await applySeatingAssignments(actor, assembly, body);
    } catch (error) {
      throwMutationError("seating.assignments", error, event);
    }
  },
);
