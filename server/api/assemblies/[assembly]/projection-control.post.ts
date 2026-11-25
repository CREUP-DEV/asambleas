import { readBodyWith } from "../../../utils/core/http";
import { defineEventHandler } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { ProjectionControlDto } from "~~/shared/types/api";
import { projectionControlBodySchema } from "~~/shared/utils/schemas/assembly";
import { requireCan } from "../../../utils/domain/actor";
import { projectionControl } from "../../../utils/domain/projectionControl";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * A session console beats while open, takes control of the projection or
 * says goodbye (server/utils/domain/projectionControl.ts), and reads who
 * holds it. Kept in memory; a change of holder is recorded
 * (`projection_control_changed`), a beat that changes nothing is not.
 */
export default defineEventHandler(
  async (event): Promise<ProjectionControlDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
    const body = await readBodyWith(event, projectionControlBodySchema);
    return projectionControl(actor, assembly.id, body);
  },
);
