import type { H3Event } from "h3";
import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { members, users } from "../../db/schema";
import { getAuthUserWithRole, requireAuth } from "../auth/requireAuth";
import type { AuthEventContext, AuthUserWithRole } from "../auth/requireAuth";
import type { ImpersonationContext } from "../auth/impersonation";
import { getEffectivePermissions, isAdmin } from "../auth/rbac";
import {
  PERMISSION_KEYS,
  readsControlSheet,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import {
  moderates,
  notesSpeakers,
  recordsResults,
  reviewsAmendments,
  viewsSeating,
} from "~~/shared/utils/permissionRules";
import type { MemberKind } from "~~/shared/constants/domain";

/**
 * The authenticated user, their permissions and the member they act for.
 * `permissions` are the role's plus those granted to the user
 * (getEffectivePermissions). Admin passes every check through `can`, as with
 * the RBAC helpers. Build one only with buildActor: it is the one place that
 * defines `isAdmin` and `can`.
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
   * executive office sees the offices (canSeeExecutiveMembers).
   */
  memberKind: MemberKind | null;
  isAdmin: boolean;
  permissions: PermissionKey[];
  can(key: PermissionKey): boolean;
  /**
   * The impersonation the request runs under; null when nobody is
   * impersonating, and for actors built outside a request (the export
   * worker's, the backfills', the public reader).
   */
  impersonation: ImpersonationContext | null;
}

/**
 * The one constructor of an Actor: requireActor, loadActorForUser, the
 * public reader of the exports (publicExportActor), the room viewer
 * (roomViewer) and the tests' testActor (server/testing/actor.ts) all go
 * through it. The member is the user's (`user.memberId`) and an Admin is
 * the role named Admin, who passes every `can`. `permissions` are taken as
 * given: getEffectivePermissions already lists every key for an Admin.
 */
export function buildActor(input: {
  user: AuthUserWithRole;
  permissions: PermissionKey[];
  memberKind: MemberKind | null;
  impersonation: ImpersonationContext | null;
}): Actor {
  const admin = isAdmin(input.user.role?.name);
  const permissions = input.permissions;
  return {
    user: input.user,
    memberId: input.user.memberId,
    memberKind: input.memberKind,
    isAdmin: admin,
    permissions,
    can: (key) => admin || permissions.includes(key),
    impersonation: input.impersonation,
  };
}

/**
 * The kind of the member an account acts for (Actor.memberKind), for actors
 * whose user was not loaded by getAuthUserWithRole with it: an impersonated
 * account and loadActorForUser's.
 */
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

  const context = event.context as AuthEventContext;
  // getAuthUserWithRole read the kind with the user; while an Admin
  // impersonates it is left unset, and the target's is read here.
  const [permissions, memberKind] = await Promise.all([
    getEffectivePermissions(user),
    context.memberKind !== undefined
      ? Promise.resolve(context.memberKind)
      : loadMemberKind(user.memberId),
  ]);

  const actor = buildActor({
    user,
    permissions,
    memberKind,
    impersonation: context.impersonation ?? null,
  });
  event.context.actor = actor;
  return actor;
}

/**
 * Rebuilds an account as an Actor outside a request, with its current
 * role, grants and member, and no impersonation: the export worker (the
 * requester, when the PDF is generated), the notification sender and the
 * boot backfills (formalBackfill, proposedBackfill), which call the domain
 * as the user who acted. Null when the account no longer exists. `image`
 * stays null (never users.image): nothing built from this actor draws a
 * photo.
 */
export async function loadActorForUser(userId: string): Promise<Actor | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      name: true,
      email: true,
      roleId: true,
      externalRole: true,
      externalName: true,
      externalInitials: true,
      university: true,
      memberId: true,
      lastRoleSyncAt: true,
    },
    with: {
      role: { columns: { id: true, name: true } },
    },
  });
  if (!user) return null;

  // The same union of role and per-user permissions as requireActor.
  const [permissions, memberKind] = await Promise.all([
    getEffectivePermissions(user),
    loadMemberKind(user.memberId),
  ]);
  return buildActor({
    user: { ...user, image: null },
    permissions,
    memberKind,
    impersonation: null,
  });
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
  return moderates(actor.can);
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
 * records results (assembly:vote_result), who do it from there
 * (CONTROL_SHEET_READER_KEYS, the one definition of its readers).
 */
export function canViewControlSheet(actor: Actor): boolean {
  return readsControlSheet(actor.can);
}

/**
 * Recording results (user's decision of 2026-11-19): votes and decisions
 * on amendments, documents' final votes and votes on agenda items, from the
 * console (the Mesa) or the control sheet. Besides the Mesa, whoever holds
 * assembly:vote_result, who records them from the sheet and never projects.
 */
export function canRecordResults(actor: Actor): boolean {
  return recordsResults(actor.can);
}

/**
 * Noting who spoke on an agenda item or an amendment (user's decision of
 * 2026-11-19), from the live view and the control sheet: the Mesa and
 * whoever holds session:record_speakers.
 */
export function canNoteSpeakers(actor: Actor): boolean {
  return notesSpeakers(actor.can);
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
  return viewsSeating(actor.can);
}

/**
 * Correcting the form of an approved text directly (user's decision of
 * 2026-11-21; formCorrections.ts). The Secretaría and the Mesa hold it by
 * default; it can be granted to anyone on its own.
 */
export function canCorrectForm(actor: Actor): boolean {
  return actor.can(PERMISSION_KEYS.DOCUMENT_CORRECT_FORM);
}

/** Laying out the room and seating people. */
export function canEditSeating(actor: Actor): boolean {
  return actor.can(PERMISSION_KEYS.SEATING_EDIT);
}

/**
 * Admission review and amendment management (Secretaría):
 * amendment:review, or amendment:manage, which implies it
 * (PERMISSION_IMPLIED_BY).
 */
export function canReviewAmendments(actor: Actor): boolean {
  return reviewsAmendments(actor.can);
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
