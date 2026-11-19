import type { H3Event } from "h3";
import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { members } from "../../db/schema";
import { getAuthUserWithRole, requireAuth } from "../auth/requireAuth";
import type { AuthEventContext, AuthUserWithRole } from "../auth/requireAuth";
import type { ImpersonationContext } from "../auth/impersonation";
import { getEffectivePermissions, isAdmin } from "../auth/rbac";
import {
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import type { MemberKind } from "~~/shared/constants/domain";

/**
 * The authenticated user, their permissions and the member they act for.
 * `permissions` are the role's plus those granted to the user
 * (getEffectivePermissions). Admin passes every check through `can`, as with
 * the RBAC helpers.
 *
 * While an Admin acts as another account, `user` is that account (its
 * permissions, member, visibility and authorship) and `impersonation` names
 * the real Admin; recordEvent and recordAudit record it with every change.
 */
export interface Actor {
  user: AuthUserWithRole;
  memberId: string | null;
  /**
   * The kind of that member; null without one. An account acting for an
   * executive area sees the areas (canSeeExecutiveMembers). Actors built by
   * hand may leave it out, which reads as "not an executive area".
   */
  memberKind?: MemberKind | null;
  isAdmin: boolean;
  permissions: PermissionKey[];
  can(key: PermissionKey): boolean;
  /**
   * The impersonation the request runs under; null or absent when nobody
   * is impersonating (actors built outside a request, such as the export
   * worker's, may leave it out).
   */
  impersonation?: ImpersonationContext | null;
}

/** The kind of the member an account acts for (Actor.memberKind). */
export async function loadMemberKind(
  memberId: string | null,
): Promise<MemberKind | null> {
  if (!memberId) return null;
  const [row] = await db
    .select({ kind: members.kind })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  return row?.kind ?? null;
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
  const permissions = await getEffectivePermissions(user);

  const actor: Actor = {
    user,
    memberId: user.memberId,
    memberKind: await loadMemberKind(user.memberId),
    isAdmin: admin,
    permissions,
    can: (key) => admin || permissions.includes(key),
    impersonation: (event.context as AuthEventContext).impersonation ?? null,
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

/**
 * Reading the control sheet of an assembly (hoja de control): whoever may
 * edit it reads it too, and so do whoever notes the speakers and whoever
 * records results (assembly:vote_result), who do it from there.
 */
export function canViewControlSheet(actor: Actor): boolean {
  return (
    actor.can(PERMISSION_KEYS.CONTROL_SHEET_VIEW) ||
    actor.can(PERMISSION_KEYS.CONTROL_SHEET_EDIT) ||
    actor.can(PERMISSION_KEYS.SESSION_RECORD_SPEAKERS) ||
    actor.can(PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT)
  );
}

/**
 * Recording results (user's decision of 2026-11-19): votes and decisions
 * on amendments, documents' final votes and votes on agenda items, from the
 * console (the Mesa) or the control sheet. Besides the Mesa, whoever holds
 * assembly:vote_result, who records them from the sheet and never projects.
 */
export function canRecordResults(actor: Actor): boolean {
  return canModerate(actor) || actor.can(PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT);
}

/**
 * Noting who spoke on an agenda item or an amendment (user's decision of
 * 2026-11-19), from the live view and the control sheet: the Mesa and
 * whoever holds session:record_speakers.
 */
export function canNoteSpeakers(actor: Actor): boolean {
  return (
    canModerate(actor) || actor.can(PERMISSION_KEYS.SESSION_RECORD_SPEAKERS)
  );
}

/** Writing the control sheet: observations, the CEA position, its rows. */
export function canEditControlSheet(actor: Actor): boolean {
  return actor.can(PERMISSION_KEYS.CONTROL_SHEET_EDIT);
}

/**
 * Reading the room of an assembly (Sala): who sits where, with names and
 * photos. Whoever may edit it reads it too.
 */
export function canViewSeating(actor: Actor): boolean {
  return (
    actor.can(PERMISSION_KEYS.SEATING_VIEW) ||
    actor.can(PERMISSION_KEYS.SEATING_EDIT)
  );
}

/** Laying out the room and seating people. */
export function canEditSeating(actor: Actor): boolean {
  return actor.can(PERMISSION_KEYS.SEATING_EDIT);
}

/** Admission review and amendment management (Secretaría). */
export function canReviewAmendments(actor: Actor): boolean {
  return (
    actor.can(PERMISSION_KEYS.AMENDMENT_REVIEW) ||
    actor.can(PERMISSION_KEYS.AMENDMENT_MANAGE)
  );
}

/**
 * Answer for an account that acts for no member (users.memberId) and tries
 * to present something: the Secretaría links it (PUT
 * /api/admin/users/[id]/member through an admin).
 */
export const UNLINKED_ACCOUNT_MESSAGE =
  "Tu cuenta no está vinculada a ningún miembro. Pide a la Secretaría que la vincule a tu consejo, sectorial o cargo de la CEA.";

/** Whether the actor speaks for any of the given members. */
export function actsFor(
  actor: Actor,
  memberIds: (string | null | undefined)[],
): boolean {
  return Boolean(actor.memberId && memberIds.includes(actor.memberId));
}
