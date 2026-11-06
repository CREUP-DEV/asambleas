import type { H3Event } from "h3";
import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { auth } from "./auth";
import { resolveImpersonation } from "./impersonation";
import type { ImpersonationContext } from "./impersonation";
import type { PermissionKey } from "~~/shared/constants/permissions";

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

export interface AuthUserWithRole {
  id: string;
  name: string;
  email: string;
  image: string | null;
  roleId: string | null;
  externalRole: string | null;
  externalName: string | null;
  externalInitials: string | null;
  university: string | null;
  memberId: string | null;
  lastRoleSyncAt: Date | null;
  role: {
    id: string;
    name: string;
  } | null;
}

/**
 * What the auth helpers leave on event.context. Identity comes only from
 * `user` (through getAuthUserWithRole, requireActor or the RBAC helpers),
 * never from `session.user`: while an Admin acts as another account the
 * session still belongs to the Admin.
 */
export interface AuthEventContext {
  /** The better-auth session: always the signed-in (real) user's. */
  session?: AuthSession;
  /**
   * The effective user every check, visibility rule and authorship column
   * uses: the account acted as while an Admin impersonates it, otherwise
   * the signed-in user.
   */
  user?: AuthUserWithRole;
  /** The signed-in user, set on every request; the same object as `user` when nobody is impersonating. */
  realUser?: AuthUserWithRole;
  /** The impersonation the request runs under, or null (set with `realUser`). */
  impersonation?: ImpersonationContext | null;
  /** The effective user's role. */
  role?: AuthUserWithRole["role"];
  /** The effective user's permissions (attachAuthContext). */
  permissions?: PermissionKey[];
}

export async function requireAuth(event: H3Event) {
  const context = event.context as AuthEventContext;

  if (context.session) {
    return context.session;
  }

  const session = await auth.api.getSession({
    headers: event.headers,
  });

  if (!session) {
    throw createError({
      statusCode: 401,
      message: "No autorizado",
    });
  }

  context.session = session;
  return session;
}

/**
 * The signed-in account with its role, and whether it lost access
 * (users.access_revoked_at). The flag stays out of AuthUserWithRole, so it
 * never reaches a DTO.
 */
async function loadUserWithRole(
  userId: string,
): Promise<{ user: AuthUserWithRole; accessRevoked: boolean } | null> {
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      roleId: true,
      externalRole: true,
      externalName: true,
      externalInitials: true,
      university: true,
      memberId: true,
      lastRoleSyncAt: true,
      accessRevokedAt: true,
    },
    with: {
      role: { columns: { id: true, name: true } },
    },
  });
  if (!row) return null;
  const { accessRevokedAt, ...user } = row;
  return { user, accessRevoked: accessRevokedAt !== null };
}

/**
 * The effective user of the request, loaded once and cached on the
 * context. When the signed-in user is Admin and an impersonation applies to
 * their session (impersonation.ts), the request runs entirely as the
 * target: `context.user` is the target, `context.realUser` the Admin and
 * `context.impersonation` the row. Losing the Admin role, the expiry or the
 * target becoming Admin stop it at once, since the real role is read on
 * every request.
 *
 * An account that lost access (users.access_revoked_at, an account the
 * Intranet deleted) gets 401 on every request, read from the database each
 * time: revoking deletes its sessions, but better-auth's session cookie
 * cache would otherwise keep its other devices signed in for minutes.
 */
export async function getAuthUserWithRole(
  event: H3Event,
): Promise<AuthUserWithRole | null> {
  const context = event.context as AuthEventContext;

  if (context.user) {
    return context.user;
  }

  const session = await requireAuth(event);
  const loaded = await loadUserWithRole(session.user.id);
  if (!loaded) {
    return null;
  }
  if (loaded.accessRevoked) {
    throw createError({
      statusCode: 401,
      message: "No autorizado",
    });
  }
  const realUser = loaded.user;

  const impersonated = await resolveImpersonation(event, {
    sessionId: session.session.id,
    realUser,
  });
  const user = impersonated?.user ?? realUser;

  context.realUser = realUser;
  context.impersonation = impersonated?.impersonation ?? null;
  context.user = user;
  context.role = user.role;

  return user;
}
