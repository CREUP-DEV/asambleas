import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../db";
import { users, roles } from "../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { logError, logInfo, logWarn } from "../core/logger";

const ExternalRoleResponse = z.object({
  role: z.string(),
  name: z.string(),
  initials: z.string(),
  university: z.string().nullable(),
});

type ExternalPayload = z.infer<typeof ExternalRoleResponse>;

function getRoleApiUrl(): string | null {
  const url = process.env.NUXT_ROLE_API_URL?.trim();
  return url || null;
}

function getInitialAdminEmail(): string {
  return (process.env.INITIAL_ADMIN_EMAIL || "tic@creup.es")
    .trim()
    .toLowerCase();
}

async function fetchExternalRole(email: string) {
  const apiUrl = getRoleApiUrl();
  if (!apiUrl) {
    logWarn("roleSync", { reason: "NUXT_ROLE_API_URL not configured" });
    return null;
  }

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(10_000),
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

function resolveTargetRole(
  externalRole: string,
  currentRoleName: string | null,
  isNewUser: boolean,
): string | null {
  const isExternalAsociado = externalRole === "Asociado";

  if (isNewUser) {
    return isExternalAsociado ? SYSTEM_ROLES.ASOCIADO : SYSTEM_ROLES.INVITADO;
  }

  if (
    currentRoleName === SYSTEM_ROLES.ADMIN ||
    currentRoleName === SYSTEM_ROLES.SECRETARIA ||
    currentRoleName === SYSTEM_ROLES.MODERADOR
  ) {
    return null;
  }

  if (currentRoleName === SYSTEM_ROLES.ASOCIADO && !isExternalAsociado) {
    return SYSTEM_ROLES.INVITADO;
  }

  if (currentRoleName === SYSTEM_ROLES.INVITADO && isExternalAsociado) {
    return SYSTEM_ROLES.ASOCIADO;
  }

  return null;
}

interface RoleSyncUpdate {
  lastRoleSyncAt: Date;
  externalRole?: string;
  externalName?: string;
  externalInitials?: string;
  university?: string | null;
  roleId?: string;
}

interface FreshUserRow {
  id: string;
  email: string;
  roleId: string | null;
  role: { name: string } | null | undefined;
}

export function computeRoleSyncUpdate(
  freshUser: FreshUserRow,
  external: ExternalPayload | null,
  isInitialAdmin: boolean,
): { fields: RoleSyncUpdate; assignRoleName: string | null } {
  const isNewUser = !freshUser.roleId;
  const fields: RoleSyncUpdate = {
    lastRoleSyncAt: new Date(),
  };

  let assignRoleName: string | null = null;

  if (external) {
    fields.externalRole = external.role;
    fields.externalName = external.name;
    fields.externalInitials = external.initials;
    fields.university = external.university;

    const currentRoleName = freshUser.role?.name ?? null;
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

  return { fields, assignRoleName };
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

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`,
    );

    const freshUser = await tx.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true, roleId: true },
      with: { role: { columns: { name: true } } },
    });

    if (!freshUser) {
      return;
    }

    const isNewUser = !freshUser.roleId;
    const isInitialAdmin =
      isNewUser && freshUser.email.toLowerCase() === getInitialAdminEmail();

    const { fields: updateFields, assignRoleName } = computeRoleSyncUpdate(
      freshUser,
      external,
      isInitialAdmin,
    );

    if (assignRoleName) {
      const targetRoleId = await getRoleIdByNameTx(tx, assignRoleName);
      if (targetRoleId) {
        updateFields.roleId = targetRoleId;
        if (isInitialAdmin) {
          logInfo("roleSync", {
            action: "initial admin assigned",
            email: freshUser.email,
          });
        } else {
          logInfo("roleSync", {
            action: "role changed",
            from: freshUser.role?.name ?? null,
            to: assignRoleName,
            email: freshUser.email,
          });
        }
      }
    }

    await tx.update(users).set(updateFields).where(eq(users.id, userId));
  });
}
