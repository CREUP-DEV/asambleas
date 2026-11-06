import { defineEventHandler, readBody, createError } from "h3";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../../db";
import { users, roles } from "../../../../db/schema";
import { AUDIT_ACTIONS } from "~~/shared/constants/activity";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ADMIN_GRANT_MESSAGES,
  adminGrantViolation,
  getUserPermissions,
  requireAnyPermission,
  touchesLeadershipRole,
} from "../../../../utils/auth/rbac";
import { endImpersonations } from "../../../../utils/auth/impersonation";
import { recordAudit } from "../../../../utils/domain/audit";
import { isDefaultCuid, validateAuthId } from "../../../../utils/validation";

const bodySchema = z.object({
  roleId: z.string().refine(isDefaultCuid),
});

function targetRevokedError() {
  return createError({
    statusCode: 409,
    message: "La cuenta no tiene acceso a la plataforma: su rol no se cambia",
    data: { messageKey: "admin.users.errors.targetRevoked" },
  });
}

/**
 * Changes a user's role (user:manage_roles). Only an Admin gives or takes
 * the Admin role, and only an Admin changes its own role (403 otherwise,
 * adminGrantViolation); the last Admin who can sign in cannot leave the role
 * (409), so someone can always manage it. A non-Admin may not give or take,
 * through the role, a permission it does not hold itself (403).
 *
 * An account without access (users.access_revoked_at: the Intranet deleted
 * it) keeps Invitado: its role cannot change (409
 * `admin.users.errors.targetRevoked`). Access comes back only from the
 * Intranet, and a role given to it would count for nothing, or let the last
 * Admin who can sign in leave the role.
 *
 * Writes `role.assign` (before/after role) when the role changes. Giving or
 * taking the Admin role also ends, as `revoked`, the impersonations it
 * stops: an Admin who is no longer one, or a target who now is.
 */
export default defineEventHandler(async (event) => {
  const caller = await requireAnyPermission(event, [
    PERMISSION_KEYS.USER_MANAGE_ROLES,
  ]);
  const { admin, permissions } = caller;
  const userId = validateAuthId(getRouterParam(event, "id"));

  const body = await readBody(event);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "roleId requerido" });
  }

  const targetRole = await db.query.roles.findFirst({
    where: eq(roles.id, parsed.data.roleId),
    columns: { id: true, name: true },
  });

  if (!targetRole) {
    throw createError({ statusCode: 404, message: "Rol no encontrado" });
  }

  const targetUser = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, email: true, roleId: true, accessRevokedAt: true },
    with: { role: { columns: { name: true } } },
  });

  if (!targetUser) {
    throw createError({ statusCode: 404, message: "Usuario no encontrado" });
  }

  if (targetUser.accessRevokedAt) {
    throw targetRevokedError();
  }

  // Identity comes from the caller, never from the session.
  const self = targetUser.id === caller.user.id;
  if (!admin && self) {
    throw createError({
      statusCode: 403,
      message: ADMIN_GRANT_MESSAGES.own_user_role,
    });
  }

  if (
    !admin &&
    (targetRole.name === SYSTEM_ROLES.ADMIN ||
      targetUser.role?.name === SYSTEM_ROLES.ADMIN)
  ) {
    throw createError({
      statusCode: 403,
      message: "Solo un Admin puede dar o quitar el rol Admin",
    });
  }

  if (
    targetUser.roleId !== targetRole.id &&
    touchesLeadershipRole(admin, [targetRole.name, targetUser.role?.name])
  ) {
    throw createError({
      statusCode: 403,
      message: ADMIN_GRANT_MESSAGES.leadership,
    });
  }

  if (!admin && targetUser.roleId !== targetRole.id) {
    const violation = adminGrantViolation({
      admin,
      callerPermissions: permissions,
      ownTarget: false,
      target: "user_role",
      before: targetUser.roleId
        ? await getUserPermissions(targetUser.roleId)
        : [],
      after: await getUserPermissions(targetRole.id),
    });
    if (violation) {
      throw createError({
        statusCode: 403,
        message: ADMIN_GRANT_MESSAGES[violation],
      });
    }
  }

  const leavesAdmin =
    targetUser.role?.name === SYSTEM_ROLES.ADMIN &&
    targetRole.name !== SYSTEM_ROLES.ADMIN;
  const touchesAdmin =
    targetUser.roleId !== targetRole.id &&
    (targetUser.role?.name === SYSTEM_ROLES.ADMIN ||
      targetRole.name === SYSTEM_ROLES.ADMIN);

  await db.transaction(async (tx) => {
    if (leavesAdmin && targetUser.roleId) {
      // The Admin accounts that can sign in, locked in id order: two Admins
      // leaving the role at once cannot both see the other one still there.
      // An Admin without access does not count (it cannot sign in).
      const admins = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.roleId, targetUser.roleId),
            isNull(users.accessRevokedAt),
          ),
        )
        .orderBy(asc(users.id))
        .for("no key update");
      if (admins.every((row) => row.id === targetUser.id)) {
        throw createError({
          statusCode: 409,
          message:
            "Tiene que quedar al menos un Admin: da antes el rol Admin a otra persona",
        });
      }
    }
    // Only while the account has access: a revocation that committed since
    // the read above (it locks the row) leaves nothing to update.
    const updated = await tx
      .update(users)
      .set({ roleId: parsed.data.roleId })
      .where(and(eq(users.id, userId), isNull(users.accessRevokedAt)))
      .returning({ id: users.id });
    if (updated.length === 0) {
      throw targetRevokedError();
    }

    // No row when the role stays the same (recordAudit skips the no-op).
    await recordAudit(tx, {
      event,
      actor: caller,
      action: AUDIT_ACTIONS.ROLE_ASSIGN,
      targetType: "user",
      targetId: userId,
      before: {
        roleId: targetUser.roleId ?? null,
        roleName: targetUser.role?.name ?? null,
      },
      after: { roleId: targetRole.id, roleName: targetRole.name },
    });

    if (touchesAdmin) {
      // The lookup would also close them on the Admin's next request; closing
      // them here keeps the impersonations list right meanwhile. The rows
      // name the impersonating Admin, so the caller's IP stays out of them.
      await endImpersonations(tx, { userId }, "revoked", {
        ipAddress: null,
        userAgent: null,
      });
    }
  });

  return {
    success: true,
    roleId: parsed.data.roleId,
    roleName: targetRole.name,
  };
});
