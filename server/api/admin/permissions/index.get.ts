import { defineEventHandler } from "h3";
import { db } from "../../../db";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireAnyPermission } from "../../../utils/auth/rbac";

/**
 * The permission catalog. Read by whoever manages roles and by whoever
 * grants permissions to users.
 */
export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, [
    PERMISSION_KEYS.USER_MANAGE_ROLES,
    PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
  ]);

  const allPermissions = await db.query.permissions.findMany({
    columns: {
      id: true,
      key: true,
      description: true,
    },
    orderBy: (p, { asc }) => [asc(p.key)],
  });

  return { data: allPermissions };
});
