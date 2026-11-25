import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { SeatingGroupDto } from "~~/shared/types/api";
import { seatingGroupCreateBodySchema } from "~~/shared/utils/schemas/seating";
import {
  createSeatingGroup,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/** Adds a group made by hand to the room («Prensa»), seating:edit. */
export default defineEventHandler(async (event): Promise<SeatingGroupDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireSeatingEditor(actor);
  const body = await readBodyWith(event, seatingGroupCreateBodySchema);
  try {
    return await createSeatingGroup(actor, assembly, body);
  } catch (error) {
    throwMutationError("seating.group", error, event);
  }
});
