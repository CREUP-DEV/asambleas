import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingGroupDto } from "~~/shared/types/api";
import { seatingGroupUpdateBodySchema } from "~~/shared/utils/schemas/seating";
import { requireActor } from "../../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import {
  requireSeatingEditor,
  updateSeatingGroup,
} from "../../../../../utils/domain/seating";
import { throwMutationError } from "../../../../../utils/errors";

/** Changes a group made by hand (seating:edit), with its optimistic lock. */
export default defineEventHandler(async (event): Promise<SeatingGroupDto> => {
  const actor = await requireActor(event);
  requireSeatingEditor(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = await readBodyWith(event, seatingGroupUpdateBodySchema);
  try {
    return await updateSeatingGroup(
      actor,
      assembly,
      getRouterParam(event, "group"),
      body,
    );
  } catch (error) {
    throwMutationError("seating.group", error, event);
  }
});
