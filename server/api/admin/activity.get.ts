import { defineEventHandler } from "h3";
import { readQueryWith } from "../../utils/core/http";
import type { ActivityPageDto } from "~~/shared/types/api";
import { adminActivityQuerySchema } from "~~/shared/utils/schemas/activity";
import { requireAdmin } from "../../utils/auth/rbac";
import { loadAdminActivity } from "../../utils/domain/activity";

/**
 * The whole activity log, unredacted, with IPs (Admin only: the real role,
 * never a permission key; 403 while impersonating). Filters combine with
 * AND; newest first, paged by `cursor`.
 */
export default defineEventHandler(async (event): Promise<ActivityPageDto> => {
  await requireAdmin(event);
  const query = readQueryWith(event, adminActivityQuerySchema);
  return loadAdminActivity(query);
});
