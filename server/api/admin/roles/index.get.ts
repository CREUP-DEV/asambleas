import { defineEventHandler } from "h3";
import { db } from "../../../db";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireAnyPermission } from "../../../utils/auth/rbac";

/** The roles. Read by whoever manages roles and by whoever assigns them. */
export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, [
    PERMISSION_KEYS.USER_MANAGE_ROLES,
    PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS,
  ]);

  const allRoles = await db.query.roles.findMany({
    columns: {
      id: true,
      name: true,
      description: true,
      isSystem: true,
    },
    orderBy: (r, { asc }) => [asc(r.name)],
  });

  return { data: allRoles };
});
