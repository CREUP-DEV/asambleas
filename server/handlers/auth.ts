import { createError, defineEventHandler } from "h3";
import {
  ADMIN_SECTION_PERMISSIONS,
  attachAuthContext,
  hasAnyPermission,
} from "../utils/auth/rbac";
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
 */
export default defineEventHandler(async (event) => {
  if (event.method === "OPTIONS") {
    return;
  }

  assertSameOriginMutation(event);
  await attachAuthContext(event);
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
