import type { H3Event } from "h3";
import { createError } from "h3";
import { getAuthUserWithRole, requireAuth } from "../auth/requireAuth";
import type { AuthUserWithRole } from "../auth/requireAuth";
import { getUserPermissions, isAdmin } from "../auth/rbac";
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";

/**
 * The authenticated user, their permissions and the member they act for.
 * Admin passes every check through `can`, as with the RBAC helpers.
 */
export interface Actor {
  user: AuthUserWithRole;
  memberId: string | null;
  isAdmin: boolean;
  permissions: PermissionKey[];
  can(key: PermissionKey): boolean;
}

export async function requireActor(event: H3Event): Promise<Actor> {
  const cached = event.context.actor as Actor | undefined;
  if (cached) return cached;

  await requireAuth(event);
  const user = await getAuthUserWithRole(event);
  if (!user) {
    throw createError({ statusCode: 401, message: "No autorizado" });
  }

  const admin = isAdmin(user.role?.name);
  const permissions = admin
    ? (ALL_PERMISSION_KEYS as PermissionKey[])
    : user.role
      ? await getUserPermissions(user.role.id)
      : [];

  const actor: Actor = {
    user,
    memberId: user.memberId,
    isAdmin: admin,
    permissions,
    can: (key) => admin || permissions.includes(key),
  };
  event.context.actor = actor;
  return actor;
}

export function requireCan(actor: Actor, key: PermissionKey): void {
  if (!actor.can(key)) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para realizar esta acción",
    });
  }
}

/** Mesa de Moderación actions: live state, admissions, outcomes, votes. */
export function canModerate(actor: Actor): boolean {
  return actor.can(PERMISSION_KEYS.SESSION_MODERATE);
}

export function canManageAssemblies(actor: Actor): boolean {
  return actor.can(PERMISSION_KEYS.ASSEMBLY_MANAGE);
}

export function canManageDocuments(actor: Actor): boolean {
  return actor.can(PERMISSION_KEYS.DOCUMENT_MANAGE);
}

/** Admission review and amendment management (Secretaría). */
export function canReviewAmendments(actor: Actor): boolean {
  return (
    actor.can(PERMISSION_KEYS.AMENDMENT_REVIEW) ||
    actor.can(PERMISSION_KEYS.AMENDMENT_MANAGE)
  );
}

/** Whether the actor speaks for any of the given members. */
export function actsFor(actor: Actor, memberIds: (string | null | undefined)[]): boolean {
  return Boolean(actor.memberId && memberIds.includes(actor.memberId));
}
