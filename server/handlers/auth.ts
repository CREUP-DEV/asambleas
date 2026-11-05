import { createError, defineEventHandler } from "h3";
import {
  ADMIN_SECTION_PERMISSIONS,
  attachAuthContext,
  hasAnyPermission,
} from "../utils/auth/rbac";
import {
  assertActingUser,
  assertNotImpersonatingMutation,
} from "../utils/auth/impersonation";
import type { AuthEventContext } from "../utils/auth/requireAuth";
import {
  assertSameOriginMutation,
  ensureCsrfCookie,
  assertCsrfMutation,
} from "../utils/auth/requestProtection";

/**
 * The admin section (/api/admin): authenticated users holding
 * user:manage_roles or role:manage_permissions (Admin has every key). Each
 * endpoint then checks the permission it needs, and only an Admin may give
 * or take the Admin role or change that role's permissions.
 *
 * Before the section gate, so a stale tab gets the answer that makes it
 * reload rather than a 403 from the account it no longer acts as:
 * - unsafe requests must name the effective user in `x-acting-user` (409
 *   `auth.identityChanged`);
 * - while an Admin acts as another account the whole section is read-only
 *   (403 `admin.impersonationReadOnly`): changes to users, roles, grants
 *   and links always carry the real Admin. Starting a second impersonation
 *   is refused here too.
 */
export default defineEventHandler(async (event) => {
  if (event.method === "OPTIONS") {
    return;
  }

  assertSameOriginMutation(event);
  await attachAuthContext(event);
  assertActingUser(event);
  assertNotImpersonatingMutation(event);
  const permissions = (event.context as AuthEventContext).permissions ?? [];
  if (!hasAnyPermission(permissions, ADMIN_SECTION_PERMISSIONS)) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para gestionar usuarios ni roles",
    });
  }
  ensureCsrfCookie(event);
  assertCsrfMutation(event);
});
