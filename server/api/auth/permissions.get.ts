import { defineEventHandler, setHeader } from "h3";
import { getAuthUserWithRole } from "../../utils/auth/requireAuth";
import { getUserPermissions, isAdmin } from "../../utils/auth/rbac";
import { ALL_PERMISSION_KEYS } from "~~/shared/constants/permissions";

export default defineEventHandler(async (event) => {
  setHeader(event, "cache-control", "no-store");

  const user = await getAuthUserWithRole(event);

  if (!user?.role) {
    return { permissions: [], role: null };
  }

  if (isAdmin(user.role.name)) {
    return {
      permissions: ALL_PERMISSION_KEYS,
      role: user.role.name,
    };
  }

  const permissions = user.roleId ? await getUserPermissions(user.roleId) : [];

  return {
    permissions,
    role: user.role.name,
  };
});
