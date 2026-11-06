import type { H3Event } from "h3";
import { createError, getRequestHeader } from "h3";
import { and, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db";
import { impersonations, roles, users } from "../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ACTING_USER_HEADER_NAME,
  IMPERSONATION_TTL_MINUTES,
} from "~~/shared/constants/security";
import {
  AUDIT_ACTIONS,
  impersonationEndAction,
  impersonationEndSource,
  type ImpersonationEndReason,
} from "~~/shared/constants/activity";
import type { ImpersonationDto, UserRef } from "~~/shared/types/api";
import { recordAudit, requestClientInfo } from "../domain/audit";
import type { Executor } from "../domain/events";
import { isUniqueConstraintViolation } from "../errors";
import { logError, logInfo } from "../core/logger";
import type { AuthEventContext, AuthUserWithRole } from "./requireAuth";

/**
 * An Admin acting as another account. The pointer is an `impersonations`
 * row keyed by the Admin's own better-auth session id: the browser keeps
 * only the Admin's cookie, no session is ever created for the target (so
 * role sync never runs for it), and getAuthUserWithRole swaps the effective
 * user on every request while the row applies. See docs/design.md,
 * "Impersonation".
 *
 * This module must not import requireAuth.ts or rbac.ts at runtime (they
 * import it): it compares role names itself.
 */

/** What getAuthUserWithRole puts on event.context.impersonation while it applies. */
export interface ImpersonationContext {
  /** impersonations.id: written as impersonation_id on the request's events and audit rows. */
  id: string;
  /** The real Admin (the signed-in account). */
  admin: { id: string; name: string; email: string };
  /** The account acted as (the effective user, context.user). */
  targetUserId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
}

/** The impersonations columns the lookup and the DTOs read. */
export interface ImpersonationRow {
  id: string;
  adminUserId: string | null;
  targetUserId: string | null;
  sessionId: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: ImpersonationEndReason | null;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Whether a role name is Admin (the same test as rbac.isAdmin). */
export function isAdminRole(roleName: string | null | undefined): boolean {
  return roleName === SYSTEM_ROLES.ADMIN;
}

// Pure rules -----------------------------------------------------------------

/**
 * What an open row means for a request:
 * - `none`: no open row: the request runs as the signed-in user;
 * - `apply`: the request runs as the target;
 * - `close`: the row no longer applies and is closed with that reason: it
 *   expired, the signed-in user is no longer Admin, or the target vanished,
 *   became Admin, lost access to the platform (users.access_revoked_at) or
 *   is the Admin itself (revoked).
 */
export type ImpersonationDecision =
  | { kind: "none" }
  | { kind: "apply" }
  | {
      kind: "close";
      reason: Extract<ImpersonationEndReason, "expired" | "revoked">;
    };

export function decideImpersonation(input: {
  realUserId: string;
  realRoleName: string | null | undefined;
  row: Pick<ImpersonationRow, "endedAt" | "expiresAt" | "targetUserId"> | null;
  /** The target as it is now; null when the account no longer exists. */
  target: {
    id: string;
    roleName: string | null | undefined;
    /** Whether the account lost access to the platform. */
    accessRevoked?: boolean;
  } | null;
  now: Date;
}): ImpersonationDecision {
  const { row, target } = input;
  if (!row || row.endedAt) return { kind: "none" };
  if (!isAdminRole(input.realRoleName)) {
    return { kind: "close", reason: "revoked" };
  }
  if (row.expiresAt.getTime() <= input.now.getTime()) {
    return { kind: "close", reason: "expired" };
  }
  if (
    !target ||
    target.id !== row.targetUserId ||
    target.id === input.realUserId ||
    isAdminRole(target.roleName) ||
    target.accessRevoked === true
  ) {
    return { kind: "close", reason: "revoked" };
  }
  return { kind: "apply" };
}

/** Spanish messages and i18n keys (`data.messageKey`) of impersonationStartBlocker. */
export const IMPERSONATION_START_ERRORS = {
  admin_only: {
    statusCode: 403,
    message: "Solo un Admin puede acceder como otra cuenta",
    messageKey: "impersonation.errors.adminOnly",
  },
  nested: {
    statusCode: 409,
    message:
      "Ya estás actuando como otra cuenta. Vuelve a la tuya antes de acceder como otra",
    messageKey: "impersonation.errors.nested",
  },
  not_found: {
    statusCode: 404,
    message: "Usuario no encontrado",
    messageKey: "impersonation.errors.notFound",
  },
  self: {
    statusCode: 422,
    message: "No puedes acceder como tu propia cuenta",
    messageKey: "impersonation.errors.self",
  },
  target_admin: {
    statusCode: 403,
    message: "No se puede acceder como otro Admin",
    messageKey: "impersonation.errors.targetAdmin",
  },
  target_revoked: {
    statusCode: 403,
    message:
      "No se puede acceder como una cuenta que ya no tiene acceso a la plataforma",
    messageKey: "impersonation.errors.targetRevoked",
  },
} as const;
export type ImpersonationStartBlocker = keyof typeof IMPERSONATION_START_ERRORS;

/**
 * Why the signed-in user may not start acting as `target`, or null when it
 * may. Only a user whose real role is Admin, not already impersonating,
 * never as itself, as another Admin or as an account that lost access to
 * the platform. Checked in this order.
 */
export function impersonationStartBlocker(input: {
  realUserId: string;
  realRoleName: string | null | undefined;
  impersonating: boolean;
  target: {
    id: string;
    roleName: string | null | undefined;
    accessRevoked?: boolean;
  } | null;
}): ImpersonationStartBlocker | null {
  if (!isAdminRole(input.realRoleName)) return "admin_only";
  if (input.impersonating) return "nested";
  if (!input.target) return "not_found";
  if (input.target.id === input.realUserId) return "self";
  if (isAdminRole(input.target.roleName)) return "target_admin";
  if (input.target.accessRevoked === true) return "target_revoked";
  return null;
}

/**
 * When an impersonation started at `startedAt` ends by itself: after
 * IMPERSONATION_TTL_MINUTES, or when the Admin's own session ends if that
 * comes first. Fixed on start; never renewed.
 */
export function impersonationExpiry(
  startedAt: Date,
  sessionExpiresAt: Date | null,
  ttlMinutes: number = IMPERSONATION_TTL_MINUTES,
): Date {
  const limit = startedAt.getTime() + ttlMinutes * 60_000;
  const session = sessionExpiresAt?.getTime();
  return new Date(
    session !== undefined && Number.isFinite(session)
      ? Math.min(limit, session)
      : limit,
  );
}

/**
 * Whether an unsafe request carries the wrong `x-acting-user` header
 * (ACTING_USER_HEADER_NAME). When the signed-in user is Admin the header is
 * required, since identity can switch under it (impersonation started,
 * stopped or expired in another tab); for everyone else a header that is
 * present must match too (another account signed in meanwhile).
 */
export function actingUserConflict(input: {
  method: string;
  realIsAdmin: boolean;
  effectiveUserId: string | null;
  header: string | null | undefined;
}): boolean {
  if (!UNSAFE_METHODS.has(input.method.toUpperCase())) return false;
  const header = input.header?.trim() || null;
  if (input.realIsAdmin) return header !== input.effectiveUserId;
  return header !== null && header !== input.effectiveUserId;
}

/** Whether an impersonation applies at `now` (open and not expired). */
export function impersonationIsActive(
  row: Pick<ImpersonationRow, "endedAt" | "expiresAt">,
  now: Date = new Date(),
): boolean {
  return !row.endedAt && row.expiresAt.getTime() > now.getTime();
}

/** An impersonations row as the API returns it. */
export function toImpersonationDto(
  row: ImpersonationRow,
  people: { admin: UserRef | null; target: UserRef | null },
  now: Date = new Date(),
): ImpersonationDto {
  return {
    id: row.id,
    admin: people.admin,
    target: people.target,
    reason: row.reason,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason ?? null,
    active: impersonationIsActive(row, now),
  };
}

// Request guards -------------------------------------------------------------

/**
 * Section handlers call this after attachAuthContext on every request:
 * answers 409 (`data.messageKey: "auth.identityChanged"`) when an unsafe
 * request's `x-acting-user` header does not name the effective user (see
 * actingUserConflict). The client reloads on it. Skip it only for
 * DELETE /api/me/impersonation, so stopping always works.
 */
export function assertActingUser(event: H3Event): void {
  const context = event.context as AuthEventContext;
  if (!context.realUser) return;
  if (
    actingUserConflict({
      method: event.method,
      realIsAdmin: isAdminRole(context.realUser.role?.name),
      effectiveUserId: context.user?.id ?? null,
      header: getRequestHeader(event, ACTING_USER_HEADER_NAME),
    })
  ) {
    throw createError({
      statusCode: 409,
      message:
        "La cuenta con la que actúas ha cambiado. Recarga la página para continuar",
      data: { messageKey: "auth.identityChanged" },
    });
  }
}

/**
 * 403 (`data.messageKey: "admin.impersonationReadOnly"`) for an unsafe
 * request while an Admin acts as another account: the admin section
 * (/api/admin/**) and members (/api/members/**) are read-only then, so
 * changes to roles, permissions, links and members always carry the real
 * Admin. Call after attachAuthContext.
 */
export function assertNotImpersonatingMutation(event: H3Event): void {
  const context = event.context as AuthEventContext;
  if (!context.impersonation) return;
  if (!UNSAFE_METHODS.has(event.method.toUpperCase())) return;
  throw createError({
    statusCode: 403,
    message:
      "Mientras actúas como otra cuenta no puedes cambiar usuarios, roles ni miembros. Vuelve a tu cuenta para hacerlo",
    data: { messageKey: "admin.impersonationReadOnly" },
  });
}

// Database -------------------------------------------------------------------

const impersonationColumns = {
  id: impersonations.id,
  adminUserId: impersonations.adminUserId,
  targetUserId: impersonations.targetUserId,
  sessionId: impersonations.sessionId,
  reason: impersonations.reason,
  startedAt: impersonations.startedAt,
  expiresAt: impersonations.expiresAt,
  endedAt: impersonations.endedAt,
  endReason: impersonations.endReason,
};

const targetUsers = alias(users, "impersonation_target");
const targetRoles = alias(roles, "impersonation_target_role");

/**
 * The open impersonation of an Admin session (expired or not, so a stale
 * one can be closed), with the target as getAuthUserWithRole loads users.
 * `target` is null when the account no longer exists; `targetAccessRevoked`
 * says whether it lost access to the platform.
 */
export async function findOpenImpersonation(
  sessionId: string,
  executor: Executor = db,
): Promise<{
  row: ImpersonationRow;
  target: AuthUserWithRole | null;
  targetAccessRevoked: boolean;
} | null> {
  const [found] = await executor
    .select({
      row: impersonationColumns,
      target: {
        id: targetUsers.id,
        name: targetUsers.name,
        email: targetUsers.email,
        image: targetUsers.image,
        roleId: targetUsers.roleId,
        externalRole: targetUsers.externalRole,
        externalName: targetUsers.externalName,
        externalInitials: targetUsers.externalInitials,
        university: targetUsers.university,
        memberId: targetUsers.memberId,
        lastRoleSyncAt: targetUsers.lastRoleSyncAt,
      },
      targetRole: { id: targetRoles.id, name: targetRoles.name },
      targetAccessRevokedAt: targetUsers.accessRevokedAt,
    })
    .from(impersonations)
    .leftJoin(targetUsers, eq(targetUsers.id, impersonations.targetUserId))
    .leftJoin(targetRoles, eq(targetRoles.id, targetUsers.roleId))
    .where(
      and(
        eq(impersonations.sessionId, sessionId),
        isNull(impersonations.endedAt),
      ),
    )
    .limit(1);
  if (!found) return null;
  const target = found.target?.id
    ? { ...found.target, role: found.targetRole?.id ? found.targetRole : null }
    : null;
  return {
    row: found.row,
    target,
    targetAccessRevoked: Boolean(found.targetAccessRevokedAt),
  };
}

/** Which open impersonations endImpersonations closes. */
export type ImpersonationFilter =
  | { id: string }
  /** Every open one of an Admin session (sign-out). */
  | { sessionId: string }
  /**
   * Every open one where the user is the Admin or the target (role changes,
   * an account that lost access).
   */
  | { userId: string }
  /** Every open one past its expiry (a sweep before listing). */
  | { expired: true };

function filterCondition(filter: ImpersonationFilter): SQL | undefined {
  if ("id" in filter) return eq(impersonations.id, filter.id);
  if ("sessionId" in filter) {
    return eq(impersonations.sessionId, filter.sessionId);
  }
  if ("userId" in filter) {
    return or(
      eq(impersonations.adminUserId, filter.userId),
      eq(impersonations.targetUserId, filter.userId),
    );
  }
  return lte(impersonations.expiresAt, sql`now()`);
}

/**
 * Closes the open impersonations that match, once: the conditional update
 * only touches rows still open, so concurrent requests closing the same row
 * write one audit row between them. Each closed row gets its audit row
 * (impersonationEndAction), whose actor is the real Admin. An expiry ends
 * at the expiry time, everything else now. Returns the rows it closed.
 *
 * `event` gives the IP and user agent; without one (better-auth hooks) pass
 * them, or leave them empty.
 */
export async function endImpersonations(
  executor: Executor,
  filter: ImpersonationFilter,
  reason: ImpersonationEndReason,
  options: {
    event?: H3Event | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  } = {},
): Promise<ImpersonationRow[]> {
  const closed = await executor
    .update(impersonations)
    .set({
      endedAt:
        reason === "expired"
          ? sql`least(${impersonations.expiresAt}, now())`
          : sql`now()`,
      endReason: reason,
    })
    .where(and(filterCondition(filter), isNull(impersonations.endedAt)))
    .returning(impersonationColumns);

  for (const row of closed) {
    await recordAudit(executor, {
      event: options.event,
      actor: { userId: row.adminUserId, impersonationId: row.id },
      source: impersonationEndSource(reason),
      action: impersonationEndAction(reason),
      targetType: row.targetUserId ? "user" : "impersonation",
      targetId: row.targetUserId ?? row.id,
      after: {
        endReason: reason,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
      },
      ...(options.ipAddress !== undefined
        ? { ipAddress: options.ipAddress }
        : {}),
      ...(options.userAgent !== undefined
        ? { userAgent: options.userAgent }
        : {}),
    });
    logInfo("auth.impersonation", {
      action: "end",
      reason,
      impersonationId: row.id,
      adminUserId: row.adminUserId,
      targetUserId: row.targetUserId,
    });
  }
  return closed;
}

/**
 * For getAuthUserWithRole: the impersonation a request by `realUser` runs
 * under, or null. Non-Admins pay no query. A row that no longer applies is
 * closed here (expired or revoked); if closing fails the request still runs
 * as the real user, since the lookup never applies such a row anyway.
 */
export async function resolveImpersonation(
  event: H3Event,
  input: {
    sessionId: string;
    realUser: AuthUserWithRole;
    now?: Date;
  },
): Promise<{
  user: AuthUserWithRole;
  impersonation: ImpersonationContext;
} | null> {
  const { realUser } = input;
  if (!isAdminRole(realUser.role?.name)) return null;

  const found = await findOpenImpersonation(input.sessionId);
  if (!found) return null;

  const decision = decideImpersonation({
    realUserId: realUser.id,
    realRoleName: realUser.role?.name,
    row: found.row,
    target: found.target
      ? {
          id: found.target.id,
          roleName: found.target.role?.name,
          accessRevoked: found.targetAccessRevoked,
        }
      : null,
    now: input.now ?? new Date(),
  });

  if (decision.kind === "apply" && found.target) {
    return {
      user: found.target,
      impersonation: {
        id: found.row.id,
        admin: {
          id: realUser.id,
          name: realUser.externalName ?? realUser.name,
          email: realUser.email,
        },
        targetUserId: found.target.id,
        reason: found.row.reason,
        startedAt: found.row.startedAt,
        expiresAt: found.row.expiresAt,
      },
    };
  }

  if (decision.kind === "close") {
    try {
      await endImpersonations(db, { id: found.row.id }, decision.reason, {
        event,
      });
    } catch (error) {
      logError("auth.impersonation.close", error, undefined, event);
    }
  }
  return null;
}

/**
 * POST /api/admin/users/[id]/impersonate: the signed-in Admin starts acting
 * as `targetUserId`. Call after getAuthUserWithRole (the admin section
 * handler already ran it): it reads the real user, the session and any
 * impersonation from event.context. Throws the IMPERSONATION_START_ERRORS
 * (with `data.messageKey`), or 409 nested when another tab started one in
 * the same session meanwhile. Writes the row and `impersonation.start` in
 * one transaction, holding the target row (FOR SHARE) so that it cannot
 * lose access meanwhile: a revocation waits and then closes the new row.
 * No cookie changes: the client reloads.
 */
export async function startImpersonation(
  event: H3Event,
  input: { targetUserId: string; reason: string; now?: Date },
): Promise<ImpersonationDto> {
  const context = event.context as AuthEventContext;
  const realUser = context.realUser;
  const session = context.session;
  if (!realUser || !session) {
    throw createError({ statusCode: 401, message: "No autorizado" });
  }

  const [target] = await db
    .select({
      id: users.id,
      name: users.name,
      externalName: users.externalName,
      roleName: roles.name,
      accessRevokedAt: users.accessRevokedAt,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, input.targetUserId))
    .limit(1);

  const blocker = impersonationStartBlocker({
    realUserId: realUser.id,
    realRoleName: realUser.role?.name,
    impersonating: Boolean(context.impersonation),
    target: target
      ? { ...target, accessRevoked: target.accessRevokedAt !== null }
      : null,
  });
  if (blocker || !target) {
    throw startError(blocker ?? "not_found");
  }

  const startedAt = input.now ?? new Date();
  const sessionExpiresAt = new Date(session.session.expiresAt);
  const expiresAt = impersonationExpiry(
    startedAt,
    Number.isNaN(sessionExpiresAt.getTime()) ? null : sessionExpiresAt,
  );
  const client = requestClientInfo(event);

  let row: ImpersonationRow;
  try {
    row = await db.transaction(async (tx) => {
      // The target may have lost access since it was read above.
      const [stillAllowed] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, target.id), isNull(users.accessRevokedAt)))
        .for("share");
      if (!stillAllowed) throw startError("target_revoked");
      const [inserted] = await tx
        .insert(impersonations)
        .values({
          adminUserId: realUser.id,
          targetUserId: target.id,
          sessionId: session.session.id,
          reason: input.reason,
          startedAt,
          expiresAt,
          ipAddress: client.ipAddress,
          userAgent: client.userAgent,
        })
        .returning(impersonationColumns);
      if (!inserted) throw new Error("impersonation insert returned no row");
      await recordAudit(tx, {
        event,
        actor: { userId: realUser.id, impersonationId: inserted.id },
        action: AUDIT_ACTIONS.IMPERSONATION_START,
        targetType: "user",
        targetId: target.id,
        after: {
          reason: input.reason,
          expiresAt: inserted.expiresAt.toISOString(),
        },
      });
      return inserted;
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) throw startError("nested");
    throw error;
  }

  logInfo("auth.impersonation", {
    action: "start",
    impersonationId: row.id,
    adminUserId: realUser.id,
    targetUserId: target.id,
  });
  return toImpersonationDto(
    row,
    {
      admin: { id: realUser.id, name: realUser.externalName ?? realUser.name },
      target: { id: target.id, name: target.externalName ?? target.name },
    },
    startedAt,
  );
}

/** The H3 error of a start blocker, with its `data.messageKey`. */
function startError(blocker: ImpersonationStartBlocker) {
  const error = IMPERSONATION_START_ERRORS[blocker];
  return createError({
    statusCode: error.statusCode,
    message: error.message,
    data: { messageKey: error.messageKey },
  });
}

/**
 * DELETE /api/me/impersonation: the Admin goes back to their account.
 * 409 (`impersonation.errors.notActive`) when the request runs under no
 * impersonation. Writes `impersonation.stop`. The client reloads.
 */
export async function stopImpersonation(event: H3Event): Promise<void> {
  const context = event.context as AuthEventContext;
  const current = context.impersonation;
  if (!current) {
    throw createError({
      statusCode: 409,
      message: "No estás actuando como otra cuenta",
      data: { messageKey: "impersonation.errors.notActive" },
    });
  }
  await endImpersonations(db, { id: current.id }, "stopped", { event });
}
