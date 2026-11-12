import { defineEventHandler, getQuery } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { StatsDto } from "~~/shared/types/api";
import { requireAnyPermission } from "../../../utils/auth/rbac";
import { requireActor } from "../../../utils/domain/actor";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { loadStats } from "../../../utils/domain/stats";

/**
 * The statistics of an assembly (`?assembly=` slug or id), per member, per
 * account and per document (stats:view). 404 for an assembly the caller
 * may not see.
 */
export default defineEventHandler(async (event): Promise<StatsDto> => {
  await requireAnyPermission(event, [PERMISSION_KEYS.STATS_VIEW]);
  const actor = await requireActor(event);
  const { assembly } = getQuery(event);
  const row = await resolveAssembly(
    actor,
    typeof assembly === "string" ? assembly : undefined,
  );
  return loadStats(row);
});
