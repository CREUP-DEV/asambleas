import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingGroupDto } from "~~/shared/types/api";
import { seatingGroupCreateBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import {
  createSeatingGroup,
  requireSeatingEditor,
} from "../../../../../utils/domain/seating";
import { throwSeatingError } from "../../../../../utils/seating/errors";

/** Adds a group made by hand to the room («Prensa»), seating:edit. */
export default defineEventHandler(async (event): Promise<SeatingGroupDto> => {
  const actor = await requireActor(event);
  requireSeatingEditor(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readAssemblyBody(event, seatingGroupCreateBodySchema);
  try {
    return await createSeatingGroup(actor, assembly, body);
  } catch (error) {
    throwSeatingError("seating.group", error, event);
  }
});
