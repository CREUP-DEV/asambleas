import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../../../../db";
import {
  auditLog,
  permissions,
  userPermissions,
  users,
} from "../../../../db/schema";
import {
  loadAdminUser,
  loadExtraPermissions,
} from "../../../../utils/auth/adminUsers";
import {
  ADMIN_GRANT_MESSAGES,
  adminGrantViolation,
  invalidateUserPermissionCache,
  requireAnyPermission,
  touchesLeadershipRole,
} from "../../../../utils/auth/rbac";
import { logError } from "../../../../utils/core/logger";
import { validateAuthId } from "../../../../utils/validation";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import {
  normalizePermissionKeys,
  unknownPermissionKeys,
  userPermissionsBodySchema,
} from "~~/shared/utils/schemas/permissions";

/**
 * Sets the permissions granted to one user on top of their role
 * (user_permissions), as the full set: keys left out are revoked, kept ones
 * keep who granted them. Role permissions are never subtracted. Needs
 * user:manage_roles. A non-Admin may not change its own account's grants,
 * nor add or remove a key it does not hold itself (403,
 * adminGrantViolation).
 * 400 for a malformed body, 422 for keys outside the catalog, 404 for an
 * unknown user. Writes `user.permissions_set` to the audit log and returns
 * the row as GET /api/admin/users lists it.
 */
export default defineEventHandler(async (event) => {
  const caller = await requireAnyPermission(event, [
    PERMISSION_KEYS.USER_MANAGE_ROLES,
  ]);
  const { session } = caller;
  const userId = validateAuthId(getRouterParam(event, "id"));
  const deny = (input: { before?: string[]; after?: string[] }) => {
    const violation = adminGrantViolation({
      admin: caller.admin,
      callerPermissions: caller.permissions,
      ownTarget: userId === caller.user.id,
      target: "account",
      ...input,
    });
    if (violation) {
      throw createError({
        statusCode: 403,
        message: ADMIN_GRANT_MESSAGES[violation],
      });
    }
  };
  deny({});

  const parsed = userPermissionsBodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: "La lista de permisos no es válida",
    });
  }
  const unknown = unknownPermissionKeys(parsed.data.permissions);
  if (unknown.length > 0) {
    throw createError({
      statusCode: 422,
      message: "Algún permiso indicado no existe",
      data: { unknown },
    });
  }
  const keys = normalizePermissionKeys(parsed.data.permissions);

  const target = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true },
    with: { role: { columns: { name: true } } },
  });
  if (!target) {
    throw createError({ statusCode: 404, message: "Usuario no encontrado" });
  }
  if (touchesLeadershipRole(caller.admin, [target.role?.name])) {
    throw createError({
      statusCode: 403,
      message: ADMIN_GRANT_MESSAGES.leadership,
    });
  }

  const rows =
    keys.length > 0
      ? await db
          .select({ id: permissions.id, key: permissions.key })
          .from(permissions)
          .where(inArray(permissions.key, keys))
      : [];
  if (rows.length !== keys.length) {
    // The catalog knows these keys but the database does not: it was not
    // seeded after they were added (pnpm db:seed). Said to the developers
    // in the log; the admin gets plain words.
    const stored = new Set(rows.map((row) => row.key));
    logError(
      "admin.users.permissions",
      new Error("Permission keys missing from the permissions table"),
      { missing: keys.filter((key) => !stored.has(key)) },
      event,
    );
    throw createError({
      statusCode: 500,
      message: "No se han podido guardar los permisos. Avisa al equipo técnico",
    });
  }
  const permissionIds = rows.map((row) => row.id);
  const actorUserId = session?.user.id ?? null;

  await db.transaction(async (tx) => {
    // Serializes two admins editing the same user's grants.
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("no key update");
    const before = (await loadExtraPermissions([userId], tx)).get(userId) ?? [];
    deny({ before, after: keys });

    await tx
      .delete(userPermissions)
      .where(
        and(
          eq(userPermissions.userId, userId),
          permissionIds.length > 0
            ? notInArray(userPermissions.permissionId, permissionIds)
            : undefined,
        ),
      );
    if (permissionIds.length > 0) {
      await tx
        .insert(userPermissions)
        .values(
          permissionIds.map((permissionId) => ({
            userId,
            permissionId,
            grantedByUserId: actorUserId,
          })),
        )
        .onConflictDoNothing();
    }

    await tx.insert(auditLog).values({
      actorUserId,
      action: "user.permissions_set",
      targetType: "user",
      targetId: userId,
      before: { permissions: before },
      after: { permissions: keys },
    });
  });

  invalidateUserPermissionCache(userId);

  const updated = await loadAdminUser(userId);
  if (!updated) {
    throw createError({ statusCode: 404, message: "Usuario no encontrado" });
  }
  return updated;
});
