import { eq } from "drizzle-orm";
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

function getRoleApiUrl(): string | null {
  const url = process.env.NUXT_ROLE_API_URL?.trim();
  return url || null;
}

function getInitialAdminEmail(): string {
  return (process.env.INITIAL_ADMIN_EMAIL || "tic@creup.es")
    .trim()
    .toLowerCase();
}

async function getRoleIdByName(roleName: string): Promise<string | null> {
  const role = await db.query.roles.findFirst({
    where: eq(roles.name, roleName),
    columns: { id: true },
  });
  return role?.id ?? null;
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

export async function syncUserRole(userId: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      email: true,
      roleId: true,
    },
    with: {
      role: { columns: { name: true } },
    },
  });

  if (!user) {
    logWarn("roleSync", { reason: "user not found", userId });
    return;
  }

  const isNewUser = !user.roleId;
  const isInitialAdmin =
    isNewUser && user.email.toLowerCase() === getInitialAdminEmail();
  const external = await fetchExternalRole(user.email);

  const updateFields: Record<string, unknown> = {
    lastRoleSyncAt: new Date(),
  };

  if (external) {
    updateFields.externalRole = external.role;
    updateFields.externalName = external.name;
    updateFields.externalInitials = external.initials;
    updateFields.university = external.university;

    const currentRoleName = user.role?.name ?? null;
    const targetRoleName = resolveTargetRole(
      external.role,
      currentRoleName,
      isNewUser,
    );

    if (targetRoleName) {
      const targetRoleId = await getRoleIdByName(targetRoleName);
      if (targetRoleId) {
        updateFields.roleId = targetRoleId;
        logInfo("roleSync", {
          action: "role changed",
          from: currentRoleName,
          to: targetRoleName,
          email: user.email,
        });
      }
    }
  } else if (isNewUser) {
    const invitadoRoleId = await getRoleIdByName(SYSTEM_ROLES.INVITADO);
    if (invitadoRoleId) {
      updateFields.roleId = invitadoRoleId;
    }
  }

  if (isInitialAdmin) {
    const adminRoleId = await getRoleIdByName(SYSTEM_ROLES.ADMIN);
    if (adminRoleId) {
      updateFields.roleId = adminRoleId;
      logInfo("roleSync", {
        action: "initial admin assigned",
        email: user.email,
      });
    }
  }

  await db.update(users).set(updateFields).where(eq(users.id, userId));
}
