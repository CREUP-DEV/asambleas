import { defineEventHandler, getRouterParam } from "h3";
import type { SeatingPlanDto } from "~~/shared/types/api";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { requireViewer } from "../../../../utils/domain/roomView";
import {
  loadSeatingPlan,
  requireSeatingReader,
} from "../../../../utils/domain/seating";

/**
 * The room of an assembly and who sits where (seating:view or
 * seating:edit). Never as the room: `?view=room` is refused, since names and
 * photos of attendees are for the seating readers only. Creates nothing.
 */
export default defineEventHandler(async (event): Promise<SeatingPlanDto> => {
  const actor = await requireViewer(event);
  requireSeatingReader(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadSeatingPlan(actor, assembly);
});
