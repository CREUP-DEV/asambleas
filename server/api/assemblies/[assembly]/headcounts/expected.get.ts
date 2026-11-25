import { defineEventHandler } from "h3";
import type { HeadcountExpectedDto } from "~~/shared/types/api";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireCan } from "../../../../utils/domain/actor";
import { loadExpectedAttendance } from "../../../../utils/domain/headcountExpected";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * Who the Mesa's headcount form marks as expected: the members and guest
 * accounts with somebody registered for the assembly in the Intranet. The
 * Mesa only, never the room view: it names who registered.
 */
export default defineEventHandler(
  async (event): Promise<HeadcountExpectedDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireCan(actor, PERMISSION_KEYS.SESSION_MODERATE);
    return loadExpectedAttendance(assembly);
  },
);
