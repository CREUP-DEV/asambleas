import { createError, defineEventHandler, getQuery } from "h3";
import { db } from "../../../db";
import {
  ADMIN_USER_COLUMNS,
  ADMIN_USER_RELATIONS,
  adminUsersQuerySchema,
  adminUsersWhere,
  withExtraPermissions,
} from "../../../utils/auth/adminUsers";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { requireAnyPermission } from "../../../utils/auth/rbac";

/**
 * The users, with their role, member and grants (user:manage_roles).
 * `?access=revoked` lists only the accounts that lost access to the
 * platform (users.access_revoked_at set); the default lists every account.
 * `?q=` searches the name, the email, the intranet initials and the member
 * the account acts for.
 */
export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, [PERMISSION_KEYS.USER_MANAGE_ROLES]);

  const parsed = adminUsersQuerySchema.safeParse(getQuery(event));
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "Paginación o filtro inválidos",
    });
  }

  const { page, pageSize, access, q } = parsed.data;
  const offset = (page - 1) * pageSize;

  const users = await db.query.users.findMany({
    columns: ADMIN_USER_COLUMNS,
    with: ADMIN_USER_RELATIONS,
    where: adminUsersWhere(access, q),
    orderBy: (u, { asc }) => [asc(u.name)],
    limit: pageSize + 1,
    offset,
  });

  const hasNextPage = users.length > pageSize;
  // Each row also carries `extraPermissions`: grants on top of the role.
  const data = await withExtraPermissions(
    hasNextPage ? users.slice(0, pageSize) : users,
  );

  return {
    data,
    pagination: {
      page,
      pageSize,
      hasNextPage,
      hasPreviousPage: page > 1,
    },
  };
});
