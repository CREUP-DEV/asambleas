import { createError, defineEventHandler, getQuery, getRouterParam } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { StatsAccountDetailDto } from "~~/shared/types/api";
import { requireAnyPermission } from "../../../../utils/auth/rbac";
import { requireActor } from "../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { loadAccountStats } from "../../../../utils/domain/stats";
import { validateAuthId } from "../../../../utils/validation";

/**
 * One account's statistics in an assembly (`?assembly=` slug or id), with
 * the state of each read mark (stats:view).
 */
export default defineEventHandler(
  async (event): Promise<StatsAccountDetailDto> => {
    await requireAnyPermission(event, [PERMISSION_KEYS.STATS_VIEW]);
    const actor = await requireActor(event);
    const userId = validateAuthId(getRouterParam(event, "id"));
    const { assembly } = getQuery(event);
    const row = await resolveAssembly(
      actor,
      typeof assembly === "string" ? assembly : undefined,
    );
    const stats = await loadAccountStats(row, userId);
    if (!stats) {
      throw createError({ statusCode: 404, message: "Cuenta no encontrada" });
    }
    return stats;
  },
);
