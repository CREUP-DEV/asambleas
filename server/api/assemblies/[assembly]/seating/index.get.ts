import { defineEventHandler } from "h3";
import type { SeatingPlanDto } from "~~/shared/types/api";
import {
  loadSeatingPlan,
  requireSeatingReader,
} from "../../../../utils/domain/seating";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * The room of an assembly and who sits where (seating:view or
 * seating:edit). Never as the room: `?view=room` is refused, since names and
 * photos of attendees are for the seating readers only. Creates nothing.
 */
export default defineEventHandler(async (event): Promise<SeatingPlanDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  requireSeatingReader(actor);
  return loadSeatingPlan(actor, assembly);
});
