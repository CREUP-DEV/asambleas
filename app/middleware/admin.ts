import type { PermissionKey } from "~~/shared/constants/permissions";

/** "admin" means the Admin role; anything else is a permission key. */
export type AdminRequirement = "admin" | PermissionKey;

declare module "#app" {
  interface PageMeta {
    /**
     * Access to an admin page: the user needs any one of these. Pages
     * without it are Admin-only. The server checks again on every request.
     */
    adminAccess?: AdminRequirement[];
  }
}

/**
 * Client guard for the admin area, used as `middleware: "admin"`. It runs
 * after auth.global, so the signed-in user is already loaded. Users and
 * roles are Admin-only (their API is /api/admin/**); members need
 * `member:manage`, which Secretaría holds.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const { ensure, isAdmin, can } = useMe();
  await ensure();

  const required = to.meta.adminAccess ?? ["admin"];
  const allowed = required.some((requirement) =>
    requirement === "admin" ? isAdmin.value : can(requirement),
  );
  if (allowed) return;

  // `fatal` makes client-side navigations show the error page too; without
  // it the router would just cancel the navigation silently.
  return createError({
    statusCode: 403,
    fatal: true,
    data: { messageKey: "admin.forbidden" },
  });
});
