import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { users, roles, sessions } from "../../db/schema";
import {
  AUDIT_ACTIONS,
  type AccessRevokedReason,
} from "~~/shared/constants/activity";
import { PROTECTED_ROLES, SYSTEM_ROLES } from "~~/shared/constants/roles";
import { logInfo, logWarn } from "../core/logger";
import { recordAudit } from "../domain/audit";
import {
  emailFingerprint,
  isRoleLookupAuthenticated,
  lookupIntranetRole,
  type IntranetAccount,
  type IntranetRoleLookup,
} from "../members/intranet";
import {
  INTRANET_MEMBER_TYPES,
  linkUserToIntranetMember,
} from "../members/link";
import { endImpersonations } from "./impersonation";

/**
 * How the intranet role lookup went, recorded on the `auth.sign_in` audit
 * row:
 * - `ok`: the intranet answered with the account;
 * - `not_found`: an authenticated lookup said the intranet has no such
 *   account (lookupIntranetRole `notFound`). An account it knew before
 *   loses access (applyIntranetNotFound); one it never knew stays as it is;
 * - `failed`: an error, any other non-2xx answer or an invalid payload;
 *   sign-in goes on without the intranet data;
 * - `unconfigured`: no usable role lookup URL.
 */
export type RoleSyncOutcome = "ok" | "not_found" | "failed" | "unconfigured";

/** The sign-in outcome of a lookup. */
export function roleSyncOutcome(lookup: IntranetRoleLookup): RoleSyncOutcome {
  switch (lookup.outcome) {
    case "ok":
      return "ok";
    case "notFound":
      return "not_found";
    case "failed":
      return "failed";
    case "unconfigured":
      return "unconfigured";
  }
}

/** The reason role sync writes when the intranet deleted an account. */
const INTRANET_DELETED: AccessRevokedReason = "intranet_deleted";

function getInitialAdminEmail(): string {
  return (process.env.INITIAL_ADMIN_EMAIL || "tic@creup.es")
    .trim()
    .toLowerCase();
}

/**
 * Logs what lookupIntranetRole leaves to its caller (`ok`, `notFound`,
 * `unconfigured`; it logs failures itself), with the account's `accountRef`
 * and never its email.
 */
function logLookup(
  lookup: IntranetRoleLookup,
  account: { userId: string; accountRef: string | null },
): void {
  switch (lookup.outcome) {
    case "ok":
      logInfo("roleSync", { action: "lookup", outcome: "ok", ...account });
      return;
    case "notFound":
      logInfo("roleSync", {
        action: "lookup",
        outcome: "not_found",
        ...account,
      });
      return;
    case "unconfigured":
      logWarn("roleSync", {
        reason: "NUXT_ROLE_API_URL and NUXT_INTRANET_API_URL not configured",
        ...account,
      });
      return;
    case "failed":
      return;
  }
}

/** Intranet types (`users.type`) that grant a platform role; any other gives Invitado. */
const EXTERNAL_ROLES: ReadonlyMap<string, string> = new Map<string, string>([
  ["Asociado", SYSTEM_ROLES.ASOCIADO],
  ["Sectorial", SYSTEM_ROLES.SECTORIAL],
  ["CEA", SYSTEM_ROLES.CEA],
]);

/**
 * Platform roles that follow the intranet type on every sign-in. Admin,
 * Secretaría, Presidencia, Moderador and custom roles are assigned here and
 * kept (PROTECTED_ROLES).
 */
const SYNCED_ROLES: ReadonlySet<string> = new Set([
  SYSTEM_ROLES.INVITADO,
  SYSTEM_ROLES.ASOCIADO,
  SYSTEM_ROLES.SECTORIAL,
  SYSTEM_ROLES.CEA,
]);

/**
 * Role to assign after a successful sync, or null to keep the current one:
 * a new user gets the role of their intranet type (Asociado, Sectorial,
 * CEA) or Invitado; an Invitado, Asociado, Sectorial or CEA user follows
 * their type when it changes; everyone else keeps their role.
 */
export function resolveTargetRole(
  externalRole: string,
  currentRoleName: string | null,
  isNewUser: boolean,
): string | null {
  const target = EXTERNAL_ROLES.get(externalRole) ?? SYSTEM_ROLES.INVITADO;
  if (isNewUser) return target;
  if (!currentRoleName || !SYNCED_ROLES.has(currentRoleName)) return null;
  return currentRoleName === target ? null : target;
}

interface RoleSyncUpdate {
  /** Only when the lookup succeeded: it dates the last intranet data. */
  lastRoleSyncAt?: Date;
  /** The intranet `users.id`; never cleared by an answer without one. */
  intranetId?: number;
  externalRole?: string;
  externalName?: string | null;
  externalInitials?: string | null;
  university?: string | null;
  roleId?: string;
  memberId?: null;
}

interface FreshUserRow {
  id: string;
  email: string;
  roleId: string | null;
  role: { name: string } | null | undefined;
  /** Intranet type stored by the previous sync. */
  externalRole?: string | null;
}

/**
 * Whether the account stops acting for the member it is linked to
 * (users.memberId): an account with a synced role (Invitado, Asociado,
 * Sectorial, CEA)
 * whose role changes with its intranet type (say a CEA cargo whose term
 * ended), or whose intranet type stops being one linked to a member. Role
 * sync then links it again by its new type, if any. Accounts with a role
 * assigned here (Admin, Secretaría, Presidencia, Moderador, custom) keep
 * their link.
 */
export function stopsActingForMember(input: {
  isNewUser: boolean;
  currentRoleName: string | null;
  assignRoleName: string | null;
  previousExternalRole: string | null;
  externalRole: string;
}): boolean {
  if (input.isNewUser || !input.currentRoleName) return false;
  if (!SYNCED_ROLES.has(input.currentRoleName)) return false;
  const roleChanges =
    input.assignRoleName !== null &&
    input.assignRoleName !== input.currentRoleName;
  const leftMemberType =
    input.previousExternalRole !== null &&
    INTRANET_MEMBER_TYPES.has(input.previousExternalRole) &&
    !INTRANET_MEMBER_TYPES.has(input.externalRole);
  return roleChanges || leftMemberType;
}

/**
 * The role to give instead when the one sync resolved has no row (the
 * database was not seeded after a role was added): a new account gets
 * Invitado, so it is never left without a role; an existing one keeps its
 * role (null).
 */
export function fallbackRoleName(
  assignRoleName: string,
  isNewUser: boolean,
): string | null {
  return isNewUser && assignRoleName !== SYSTEM_ROLES.INVITADO
    ? SYSTEM_ROLES.INVITADO
    : null;
}

/**
 * The columns a role sync writes. `external` is the intranet account when
 * the lookup succeeded, null otherwise: only a successful lookup writes the
 * intranet data and `lastRoleSyncAt`, so a failed one may write nothing.
 */
export function computeRoleSyncUpdate(
  freshUser: FreshUserRow,
  external: IntranetAccount | null,
  isInitialAdmin: boolean,
  now: Date = new Date(),
): {
  fields: RoleSyncUpdate;
  assignRoleName: string | null;
  clearMember: boolean;
} {
  const isNewUser = !freshUser.roleId;
  const fields: RoleSyncUpdate = {};

  let assignRoleName: string | null = null;
  const currentRoleName = freshUser.role?.name ?? null;

  if (external) {
    fields.lastRoleSyncAt = now;
    if (typeof external.id === "number") fields.intranetId = external.id;
    fields.externalRole = external.role;
    fields.externalName = external.name;
    fields.externalInitials = external.initials;
    fields.university = external.university;

    const target = resolveTargetRole(external.role, currentRoleName, isNewUser);
    if (target) {
      assignRoleName = target;
    }
  } else if (isNewUser) {
    assignRoleName = SYSTEM_ROLES.INVITADO;
  }

  if (isInitialAdmin) {
    assignRoleName = SYSTEM_ROLES.ADMIN;
  }

  const clearMember =
    external !== null &&
    !isInitialAdmin &&
    stopsActingForMember({
      isNewUser,
      currentRoleName,
      assignRoleName,
      previousExternalRole: freshUser.externalRole ?? null,
      externalRole: external.role,
    });

  return { fields, assignRoleName, clearMember };
}

/**
 * What `user.role_sync` records of an account: its role and member link and
 * the intranet data role sync stores. `lastRoleSyncAt` is left out, so a
 * sync that changes nothing else writes no row.
 */
export interface RoleSyncAuditState {
  roleName: string | null;
  intranetId: number | null;
  externalRole: string | null;
  externalName: string | null;
  externalInitials: string | null;
  university: string | null;
  memberId: string | null;
}

/**
 * The account before and after a role sync update, for its audit row.
 * `writtenRoleName` is the role really written (after the fallback), or
 * null when the role stays.
 */
export function roleSyncAuditStates(input: {
  current: RoleSyncAuditState;
  update: Omit<RoleSyncUpdate, "lastRoleSyncAt" | "roleId">;
  writtenRoleName: string | null;
}): { before: RoleSyncAuditState; after: RoleSyncAuditState } {
  const { current, update } = input;
  const next = <K extends keyof RoleSyncAuditState>(
    key: K,
    value: RoleSyncAuditState[K] | undefined,
  ): RoleSyncAuditState[K] => (value === undefined ? current[key] : value);
  return {
    before: { ...current },
    after: {
      roleName: input.writtenRoleName ?? current.roleName,
      intranetId: next("intranetId", update.intranetId),
      externalRole: next("externalRole", update.externalRole),
      externalName: next("externalName", update.externalName),
      externalInitials: next("externalInitials", update.externalInitials),
      university: next("university", update.university),
      memberId: next("memberId", update.memberId),
    },
  };
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function getRoleIdByNameTx(
  tx: DbTx,
  roleName: string,
): Promise<string | null> {
  const role = await tx.query.roles.findFirst({
    where: eq(roles.name, roleName),
    columns: { id: true },
  });
  return role?.id ?? null;
}

// Access: an account the intranet deleted -----------------------------------

/**
 * Whether the intranet knew the account before: an earlier successful
 * lookup stored its type or its id. A Google account the intranet never
 * knew keeps today's behaviour when the intranet says it does not exist.
 */
export function knownToIntranet(account: {
  externalRole: string | null;
  intranetId: number | null;
}): boolean {
  return account.externalRole !== null || account.intranetId !== null;
}

/** Whether a role is never changed by the intranet (PROTECTED_ROLES). */
export function isProtectedRole(roleName: string | null | undefined): boolean {
  return (
    roleName !== null &&
    roleName !== undefined &&
    (PROTECTED_ROLES as readonly string[]).includes(roleName)
  );
}

/**
 * What an authenticated `not_found` answer does to an account:
 * - `already_revoked`: nothing, it has no access already (idempotent);
 * - `unknown`: nothing, the intranet never knew it (an Invitado by Google);
 * - `protected`: nothing but a `user.intranet_missing` row and a warning,
 *   since Admin, Secretaría, Presidencia and Moderador are assigned here;
 * - `revoke`: it loses access to the platform.
 */
export type IntranetNotFoundDecision =
  "already_revoked" | "unknown" | "protected" | "revoke";

export function decideIntranetNotFound(account: {
  accessRevokedAt: Date | null;
  externalRole: string | null;
  intranetId: number | null;
  roleName: string | null;
}): IntranetNotFoundDecision {
  if (account.accessRevokedAt) return "already_revoked";
  if (!knownToIntranet(account)) return "unknown";
  if (isProtectedRole(account.roleName)) return "protected";
  return "revoke";
}

/** What applyIntranetNotFound did. */
export type IntranetNotFoundResult =
  | { kind: "missing" }
  | { kind: "already_revoked" }
  | { kind: "unknown" }
  | { kind: "protected"; roleName: string | null }
  | { kind: "revoked"; sessionsEnded: number; impersonationsEnded: number };

/** Whether the account has no access after applyIntranetNotFound. */
export function lostAccess(result: IntranetNotFoundResult): boolean {
  return result.kind === "revoked" || result.kind === "already_revoked";
}

/**
 * Applies an authenticated `not_found` answer of the intranet to an account
 * (decideIntranetNotFound), in one transaction over the locked account row.
 * When it revokes: `access_revoked_at` and `access_revoked_reason`
 * ("intranet_deleted") are set together, the role becomes Invitado (or none
 * when that row is missing), the member link is cleared, every session of
 * the account is deleted (signed out everywhere), the open impersonations
 * of it are closed (`revoked`), and `user.access_revoked` records it
 * (source intranet, no actor). Its intranet data stay as the last lookup
 * left them. Calling it again changes nothing.
 */
export async function applyIntranetNotFound(
  userId: string,
  log: { accountRef: string | null } = { accountRef: null },
  now: Date = new Date(),
): Promise<IntranetNotFoundResult> {
  const result = await db.transaction(
    async (tx): Promise<IntranetNotFoundResult> => {
      await tx.execute(
        sql`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`,
      );
      const account = await tx.query.users.findFirst({
        where: eq(users.id, userId),
        columns: {
          id: true,
          memberId: true,
          externalRole: true,
          intranetId: true,
          accessRevokedAt: true,
        },
        with: { role: { columns: { name: true } } },
      });
      if (!account) return { kind: "missing" };
      const roleName = account.role?.name ?? null;

      const decision = decideIntranetNotFound({
        accessRevokedAt: account.accessRevokedAt,
        externalRole: account.externalRole,
        intranetId: account.intranetId,
        roleName,
      });
      if (decision === "already_revoked") return { kind: "already_revoked" };
      if (decision === "unknown") return { kind: "unknown" };
      if (decision === "protected") {
        await recordAudit(tx, {
          actor: null,
          source: "intranet",
          action: AUDIT_ACTIONS.USER_INTRANET_MISSING,
          targetType: "user",
          targetId: userId,
          after: { roleName },
        });
        return { kind: "protected", roleName };
      }

      const invitadoId = await getRoleIdByNameTx(tx, SYSTEM_ROLES.INVITADO);
      if (!invitadoId) {
        logWarn("roleSync.access", {
          reason: "role not found; run pnpm db:seed",
          role: SYSTEM_ROLES.INVITADO,
          userId,
        });
      }
      await tx
        .update(users)
        .set({
          accessRevokedAt: now,
          accessRevokedReason: INTRANET_DELETED,
          memberId: null,
          roleId: invitadoId,
        })
        .where(eq(users.id, userId));
      const ended = await tx
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id });
      const closed = await endImpersonations(tx, { userId }, "revoked");

      const outcome = {
        kind: "revoked" as const,
        sessionsEnded: ended.length,
        impersonationsEnded: closed.length,
      };
      await recordAudit(tx, {
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.USER_ACCESS_REVOKED,
        targetType: "user",
        targetId: userId,
        before: {
          roleName,
          memberId: account.memberId,
          accessRevokedReason: null,
        },
        after: {
          roleName: invitadoId ? SYSTEM_ROLES.INVITADO : null,
          memberId: null,
          accessRevokedReason: INTRANET_DELETED,
          sessionsEnded: outcome.sessionsEnded,
          impersonationsEnded: outcome.impersonationsEnded,
        },
      });
      return outcome;
    },
  );

  if (result.kind === "revoked") {
    logWarn("roleSync.access", {
      action: "access revoked",
      reason: INTRANET_DELETED,
      userId,
      accountRef: log.accountRef,
      sessionsEnded: result.sessionsEnded,
      impersonationsEnded: result.impersonationsEnded,
    });
  } else if (result.kind === "protected") {
    logWarn("roleSync.access", {
      reason: "the intranet has no account for a protected role; kept",
      roleName: result.roleName,
      userId,
      accountRef: log.accountRef,
    });
  }
  return result;
}

/**
 * Gives back access to an account that lost it, once the intranet knows it
 * again: clears `access_revoked_at` and `access_revoked_reason` together
 * and records `user.access_restored` (source intranet, no actor), in one
 * transaction. The role and the member come back with the role sync that
 * follows. Returns whether it restored anything (false when the account
 * had access already).
 */
export async function restoreIntranetAccess(userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`,
    );
    const account = await tx.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { accessRevokedAt: true, accessRevokedReason: true },
    });
    if (!account?.accessRevokedAt) return false;
    await tx
      .update(users)
      .set({ accessRevokedAt: null, accessRevokedReason: null })
      .where(eq(users.id, userId));
    await recordAudit(tx, {
      actor: null,
      source: "intranet",
      action: AUDIT_ACTIONS.USER_ACCESS_RESTORED,
      targetType: "user",
      targetId: userId,
      before: { accessRevokedReason: account.accessRevokedReason },
      after: { accessRevokedReason: null },
    });
    return true;
  });
}

/** What checkSignInAccess decided; `lookup` goes on to syncUserRole. */
export type SignInAccess =
  { allowed: true; lookup: IntranetRoleLookup | null } | { allowed: false };

/**
 * Whether an account may sign in, decided before its session exists
 * (better-auth session.create.before), with one intranet lookup:
 * - an account that lost access signs in only when the authenticated
 *   lookup returns it (200): access is restored (restoreIntranetAccess);
 *   anything else (still not found, unreachable, unauthenticated) refuses;
 * - an account the intranet deleted (authenticated `notFound` for an
 *   account it knew) loses access now (applyIntranetNotFound) and is
 *   refused; protected roles and accounts it never knew go on;
 * - any other answer, failures included, never blocks signing in.
 * `lookup` is handed to syncUserRole, so the intranet is asked once. Throws
 * only on a database error.
 */
export async function checkSignInAccess(userId: string): Promise<SignInAccess> {
  const account = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true, accessRevokedAt: true },
  });
  // No account: better-auth cannot create the session either.
  if (!account) return { allowed: true, lookup: null };

  const accountRef = emailFingerprint(account.email);
  const lookup = await lookupIntranetRole(account.email);
  logLookup(lookup, { userId, accountRef });

  if (account.accessRevokedAt) {
    if (lookup.outcome === "ok" && isRoleLookupAuthenticated()) {
      if (await restoreIntranetAccess(userId)) {
        logInfo("roleSync.access", {
          action: "access restored",
          userId,
          accountRef,
        });
      }
      return { allowed: true, lookup };
    }
    logWarn("roleSync.access", {
      action: "sign-in refused",
      reason: "access revoked",
      outcome: roleSyncOutcome(lookup),
      userId,
      accountRef,
    });
    return { allowed: false };
  }

  if (lookup.outcome === "notFound") {
    const result = await applyIntranetNotFound(userId, { accountRef });
    if (lostAccess(result)) return { allowed: false };
  }
  return { allowed: true, lookup };
}

// Role sync ---------------------------------------------------------------

/**
 * Syncs the account with the intranet on sign-in: role, member link and the
 * intranet data. `options.lookup` is the answer checkSignInAccess already
 * got (and applied); without it the intranet is asked here, and a
 * `notFound` for an account it knew revokes it (applyIntranetNotFound)
 * instead of syncing.
 *
 * Only a successful lookup writes the intranet data, `intranetId` and
 * `lastRoleSyncAt`; a failed one leaves an existing account as it was (a
 * new one gets Invitado). Changes are recorded with source `intranet` and
 * no actor, in the transaction of the update: `user.role_sync`
 * (before/after, RoleSyncAuditState) whenever anything but
 * `lastRoleSyncAt` changes, and `user.initial_admin` when
 * INITIAL_ADMIN_EMAIL receives Admin. The member link writes its own rows
 * (linkUserToIntranetMember). Returns how the intranet call went, for the
 * sign-in row.
 */
export async function syncUserRole(
  userId: string,
  options: { lookup?: IntranetRoleLookup } = {},
): Promise<RoleSyncOutcome> {
  const preview = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true },
  });

  if (!preview) {
    logWarn("roleSync", { reason: "user not found", userId });
    return "failed";
  }
  const accountRef = emailFingerprint(preview.email);

  let lookup = options.lookup;
  if (!lookup) {
    lookup = await lookupIntranetRole(preview.email);
    logLookup(lookup, { userId, accountRef });
    if (lookup.outcome === "notFound") {
      const result = await applyIntranetNotFound(userId, { accountRef });
      if (lostAccess(result)) return "not_found";
    }
  }
  const outcome = roleSyncOutcome(lookup);
  const external = lookup.outcome === "ok" ? lookup.account : null;

  // Initials stored by the previous sync: a CEA account keeps the member it
  // is linked to until they change (linkUserToIntranetMember).
  let previousInitials: string | null = null;
  let revoked = false;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`,
    );

    const freshUser = await tx.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        email: true,
        roleId: true,
        memberId: true,
        intranetId: true,
        externalRole: true,
        externalName: true,
        externalInitials: true,
        university: true,
        accessRevokedAt: true,
      },
      with: { role: { columns: { name: true } } },
    });

    if (!freshUser) {
      return;
    }
    // An account without access is synced only once checkSignInAccess
    // restored it: nothing here gives a role or a member back.
    if (freshUser.accessRevokedAt) {
      revoked = true;
      return;
    }
    previousInitials = freshUser.externalInitials;

    const isNewUser = !freshUser.roleId;
    const isInitialAdmin =
      isNewUser && freshUser.email.toLowerCase() === getInitialAdminEmail();

    const {
      fields: updateFields,
      assignRoleName,
      clearMember,
    } = computeRoleSyncUpdate(freshUser, external, isInitialAdmin);

    let roleName = assignRoleName;
    let roleWritten = false;
    if (roleName) {
      let targetRoleId = await getRoleIdByNameTx(tx, roleName);
      if (!targetRoleId) {
        const fallback = fallbackRoleName(roleName, isNewUser);
        logWarn("roleSync", {
          reason: "role not found; run pnpm db:seed",
          role: roleName,
          fallback,
          userId,
          accountRef,
        });
        if (fallback) {
          roleName = fallback;
          targetRoleId = await getRoleIdByNameTx(tx, fallback);
        }
      }
      if (targetRoleId) {
        updateFields.roleId = targetRoleId;
        roleWritten = true;
        // The logger redacts emails: the user id and the accountRef name
        // the account. The initial admin may have fallen back to Invitado
        // (no Admin row).
        if (isInitialAdmin && roleName === SYSTEM_ROLES.ADMIN) {
          logInfo("roleSync", {
            action: "initial admin assigned",
            userId,
            accountRef,
          });
        } else {
          logInfo("roleSync", {
            action: "role changed",
            from: freshUser.role?.name ?? null,
            to: roleName,
            userId,
            accountRef,
          });
        }
      }
    }

    // A role change only unlinks when the new role was really written: an
    // account whose role stays (its row is missing) keeps its member too.
    if (
      clearMember &&
      freshUser.memberId !== null &&
      (assignRoleName === null || roleWritten)
    ) {
      updateFields.memberId = null;
      logInfo("roleSync", {
        action: "member unlinked",
        memberId: freshUser.memberId,
        userId,
      });
    }

    // A failed lookup for an existing account writes nothing at all.
    if (Object.keys(updateFields).length > 0) {
      await tx.update(users).set(updateFields).where(eq(users.id, userId));
    }

    const writtenRoleName = roleWritten ? roleName : null;
    const { before, after } = roleSyncAuditStates({
      current: {
        roleName: freshUser.role?.name ?? null,
        intranetId: freshUser.intranetId,
        externalRole: freshUser.externalRole,
        externalName: freshUser.externalName,
        externalInitials: freshUser.externalInitials,
        university: freshUser.university,
        memberId: freshUser.memberId,
      },
      update: updateFields,
      writtenRoleName,
    });
    // Only when Admin was really written, not its Invitado fallback.
    if (isInitialAdmin && writtenRoleName === SYSTEM_ROLES.ADMIN) {
      await recordAudit(tx, {
        actor: null,
        source: "intranet",
        action: AUDIT_ACTIONS.USER_INITIAL_ADMIN,
        targetType: "user",
        targetId: userId,
        before: { roleName: before.roleName },
        after: { roleName: writtenRoleName },
      });
    }
    // No row when only lastRoleSyncAt moved (recordAudit skips the no-op).
    await recordAudit(tx, {
      actor: null,
      source: "intranet",
      action: AUDIT_ACTIONS.USER_ROLE_SYNC,
      targetType: "user",
      targetId: userId,
      before: { ...before },
      after: { ...after },
    });
  });

  if (revoked) {
    logWarn("roleSync", {
      reason: "account without access; not synced",
      userId,
      accountRef,
    });
    return outcome;
  }
  if (external) {
    await linkMember(userId, external, previousInitials);
  }
  return outcome;
}

/**
 * Links the account to its member: Asociado and Sectorial accounts are the
 * member in the intranet (by intranet id, then initials), and a CEA account
 * acts for its executive area (by initials). Runs after the role
 * transaction has committed, so a failure here never undoes the role
 * update nor blocks sign-in.
 */
async function linkMember(
  userId: string,
  external: IntranetAccount,
  previousInitials: string | null,
): Promise<void> {
  try {
    const memberId = await linkUserToIntranetMember(userId, external, {
      previousInitials,
    });
    if (memberId) {
      logInfo("roleSync", { action: "member linked", userId, memberId });
    }
  } catch (error) {
    logWarn("roleSync", {
      reason: "member link failed",
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
