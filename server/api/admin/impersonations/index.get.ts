import { defineEventHandler } from "h3";
import { readQueryWith } from "../../../utils/core/http";
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
    const query = readQueryWith(event, adminImpersonationQuerySchema);
    return loadAdminImpersonations(query);
  },
);
