import { createError, defineEventHandler, getQuery } from "h3";
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
  const parsed = adminActivityQuerySchema.safeParse(getQuery(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Parámetros no válidos" });
  }
  return loadAdminActivity(parsed.data);
});
