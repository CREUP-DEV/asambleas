import { readBodyWith } from "../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { ProjectionControlDto } from "~~/shared/types/api";
import { projectionControlBodySchema } from "~~/shared/utils/schemas/assembly";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import { projectionControl } from "../../../utils/domain/projectionControl";
import { resolveAssembly } from "../../../utils/domain/resolvers";

/**
 * A session console beats while open, takes control of the projection or
 * says goodbye (server/utils/domain/projectionControl.ts), and reads who
 * holds it. Kept in memory; a change of holder is recorded
 * (`projection_control_changed`), a beat that changes nothing is not.
 */
export default defineEventHandler(
  async (event): Promise<ProjectionControlDto> => {
    const actor = await requireActor(event);
    requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const body = await readBodyWith(event, projectionControlBodySchema);
    return projectionControl(actor, assembly.id, body);
  },
);
