import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { SeatingPersonDto } from "~~/shared/types/api";
import { seatingPersonCreateBodySchema } from "~~/shared/utils/schemas/seating";
import {
  createSeatingPerson,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * Adds someone by hand, or a seat without a name, to a group of the room
 * (seating:edit).
 */
export default defineEventHandler(async (event): Promise<SeatingPersonDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireSeatingEditor(actor);
  const body = await readBodyWith(event, seatingPersonCreateBodySchema);
  try {
    return await createSeatingPerson(actor, assembly, body);
  } catch (error) {
    throwMutationError("seating.person", error, event);
  }
});
