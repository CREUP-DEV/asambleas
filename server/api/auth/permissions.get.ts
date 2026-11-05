import { defineEventHandler, setHeader } from "h3";
import { getAuthUserWithRole } from "../../utils/auth/requireAuth";
import { getEffectivePermissions } from "../../utils/auth/rbac";

/** The signed-in user's role and permissions (the role's plus their own grants). */
export default defineEventHandler(async (event) => {
  setHeader(event, "cache-control", "no-store");

  const user = await getAuthUserWithRole(event);

  if (!user) {
    return { permissions: [], role: null };
  }

  return {
    permissions: await getEffectivePermissions(user),
    role: user.role?.name ?? null,
  };
});
