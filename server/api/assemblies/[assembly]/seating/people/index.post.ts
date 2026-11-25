import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingPersonDto } from "~~/shared/types/api";
import { seatingPersonCreateBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import {
  createSeatingPerson,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";

/**
 * Adds someone by hand, or a seat without a name, to a group of the room
 * (seating:edit).
 */
export default defineEventHandler(async (event): Promise<SeatingPersonDto> => {
  const actor = await requireActor(event);
  requireSeatingEditor(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readBodyWith(event, seatingPersonCreateBodySchema);
  try {
    return await createSeatingPerson(actor, assembly, body);
  } catch (error) {
    throwMutationError("seating.person", error, event);
  }
});
