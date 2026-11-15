import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingPersonDto } from "~~/shared/types/api";
import { seatingPersonCreateBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import {
  createSeatingPerson,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwSeatingError } from "../../../../../utils/seating/errors";

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
  const body = await readAssemblyBody(event, seatingPersonCreateBodySchema);
  try {
    return await createSeatingPerson(actor, assembly, body);
  } catch (error) {
    throwSeatingError("seating.person", error, event);
  }
});
