import { createError, defineEventHandler, getQuery } from "h3";
import type { AdminImpersonationPageDto } from "~~/shared/types/api";
import { adminImpersonationQuerySchema } from "~~/shared/utils/schemas/activity";
import { requireAdmin } from "../../../utils/auth/rbac";
import { loadAdminImpersonations } from "../../../utils/domain/activity";

/**
 * Every impersonation (Admin only; 403 while impersonating): who acted as
 * whom, why, when, from where and how many changes were recorded under it.
 * Newest first, paged by `cursor`.
 */
export default defineEventHandler(
  async (event): Promise<AdminImpersonationPageDto> => {
    await requireAdmin(event);
    const parsed = adminImpersonationQuerySchema.safeParse(getQuery(event));
    if (!parsed.success) {
      throw createError({ statusCode: 400, message: "Parámetros no válidos" });
    }
    return loadAdminImpersonations(parsed.data);
  },
);
