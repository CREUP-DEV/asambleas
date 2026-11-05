import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../db";
import { users, roles } from "../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { logError, logInfo, logWarn } from "../core/logger";
import {
  getIntranetApiBaseUrl,
  intranetUrl,
  INTRANET_TIMEOUT_MS,
} from "../members/intranet";
import {
  INTRANET_MEMBER_TYPES,
  linkUserToIntranetMember,
} from "../members/link";

// The intranet serializes nullable columns: an account without initials or
// university answers with null, which must not discard the whole sync.
const nullableText = z
  .string()
  .nullish()
  .transform((value) => value?.trim() || null);

const ExternalRoleResponse = z.object({
  role: z.string().trim().min(1),
  name: nullableText,
  initials: nullableText,
  university: nullableText,
});

type ExternalPayload = z.infer<typeof ExternalRoleResponse>;

/**
 * `NUXT_ROLE_API_URL` when set; otherwise `POST {NUXT_INTRANET_API_URL}/user/role`.
 */
function getRoleApiUrl(): string | null {
  const url = process.env.NUXT_ROLE_API_URL?.trim();
  if (url) return url;
  const base = getIntranetApiBaseUrl();
  return base ? intranetUrl(base, "user/role") : null;
}

function getInitialAdminEmail(): string {
  return (process.env.INITIAL_ADMIN_EMAIL || "tic@creup.es")
    .trim()
    .toLowerCase();
}

async function fetchExternalRole(email: string) {
  const apiUrl = getRoleApiUrl();
  if (!apiUrl) {
    logWarn("roleSync", {
      reason: "NUXT_ROLE_API_URL and NUXT_INTRANET_API_URL not configured",
    });
    return null;
  }

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(INTRANET_TIMEOUT_MS),
    });

    if (!response.ok) {
      logWarn("roleSync", { status: response.status, email });
      return null;
    }

    const data = await response.json();
    const parsed = ExternalRoleResponse.safeParse(data);

    if (!parsed.success) {
      logWarn("roleSync", { reason: "invalid response", email });
      return null;
    }

    return parsed.data;
  } catch (error) {
    logError("roleSync.fetch", error);
    return null;
  }
}

/** Intranet types (`users.type`) that grant a platform role; any other gives Invitado. */
const EXTERNAL_ROLES: ReadonlyMap<string, string> = new Map<string, string>([
  ["Asociado", SYSTEM_ROLES.ASOCIADO],
  ["CEA", SYSTEM_ROLES.CEA],
]);

/**
 * Platform roles that follow the intranet type on every sign-in. Admin,
 * Secretaría, Moderador and custom roles are assigned here and kept.
 */
const SYNCED_ROLES: ReadonlySet<string> = new Set([
  SYSTEM_ROLES.INVITADO,
  SYSTEM_ROLES.ASOCIADO,
  SYSTEM_ROLES.CEA,
]);

/**
 * Role to assign after a successful sync, or null to keep the current one:
 * a new user gets the role of their intranet type (Asociado, CEA) or
 * Invitado; an Invitado, Asociado or CEA user follows their type when it
 * changes; everyone else keeps their role.
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
  lastRoleSyncAt: Date;
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
 * (users.memberId): an account with a synced role (Invitado, Asociado, CEA)
 * whose role changes with its intranet type (say a CEA cargo whose term
 * ended), or whose intranet type stops being one linked to a member. Role
 * sync then links it again by its new type, if any. Accounts with a role
 * assigned here (Admin, Secretaria, Moderador, custom) keep their link.
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

export function computeRoleSyncUpdate(
  freshUser: FreshUserRow,
  external: ExternalPayload | null,
  isInitialAdmin: boolean,
): {
  fields: RoleSyncUpdate;
  assignRoleName: string | null;
  clearMember: boolean;
} {
  const isNewUser = !freshUser.roleId;
  const fields: RoleSyncUpdate = {
    lastRoleSyncAt: new Date(),
  };

  let assignRoleName: string | null = null;
  const currentRoleName = freshUser.role?.name ?? null;

  if (external) {
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

export async function syncUserRole(userId: string): Promise<void> {
  const preview = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true },
  });

  if (!preview) {
    logWarn("roleSync", { reason: "user not found", userId });
    return;
  }

  const external = await fetchExternalRole(preview.email);
  // Initials stored by the previous sync: a CEA account keeps the member it
  // is linked to until they change (linkUserToIntranetMember).
  let previousInitials: string | null = null;

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
        externalRole: true,
        externalInitials: true,
      },
      with: { role: { columns: { name: true } } },
    });

    if (!freshUser) {
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
          email: freshUser.email,
        });
        if (fallback) {
          roleName = fallback;
          targetRoleId = await getRoleIdByNameTx(tx, fallback);
        }
      }
      if (targetRoleId) {
        updateFields.roleId = targetRoleId;
        roleWritten = true;
        if (isInitialAdmin) {
          logInfo("roleSync", {
            action: "initial admin assigned",
            email: freshUser.email,
          });
        } else {
          logInfo("roleSync", {
            action: "role changed",
            from: freshUser.role?.name ?? null,
            to: roleName,
            email: freshUser.email,
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
        email: freshUser.email,
      });
    }

    await tx.update(users).set(updateFields).where(eq(users.id, userId));
  });

  if (external) {
    await linkMember(userId, external, previousInitials);
  }
}

/**
 * Links the account to its member: Asociado and Sectorial accounts are the
 * member in the intranet, and a CEA account acts for its executive area.
 * Runs after the role transaction has committed, so a failure here never
 * undoes the role update nor blocks sign-in.
 */
async function linkMember(
  userId: string,
  external: ExternalPayload,
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
