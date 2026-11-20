import type { H3Event } from "h3";
import { createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { auth } from "./auth";
import { markSeen } from "../live/online";
import { avatarUrl } from "./avatarFiles";
import { resolveImpersonation } from "./impersonation";
import type { ImpersonationContext } from "./impersonation";
import type { PermissionKey } from "~~/shared/constants/permissions";
import type { MemberKind } from "~~/shared/constants/domain";

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

export interface AuthUserWithRole {
  id: string;
  name: string;
  email: string;
  /**
   * The URL of the account's stored photo (avatarUrl, user_avatars), never
   * the Google picture in `users.image`; null until one is stored.
   */
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
  /**
   * The kind of the member the effective user acts for (null without one),
   * read with the user in getAuthUserWithRole so requireActor needs no
   * query of its own. Left unset while an Admin impersonates: requireActor
   * then reads the target's. Never part of AuthUserWithRole, which reaches
   * DTOs.
   */
  memberKind?: MemberKind | null;
}

/**
 * The better-auth session of the request (cached on the context), or 401.
 *
 * `disableRefresh`: this call never extends the session. A refresh made
 * here would move `sessions.expires_at` and send a `Set-Cookie` nobody
 * forwards (and an SSR `$fetch` could not), which used up the daily
 * refresh (`updateAge`) before the browser asked: the cookie then kept the
 * 7 days of the sign-in. Only the browser's own GET /api/auth/get-session
 * (app/plugins/session-keepalive.client.ts) refreshes, so the row and the
 * cookie are extended together. Expired sessions are still refused and
 * deleted here.
 */
export async function requireAuth(event: H3Event) {
  const context = event.context as AuthEventContext;

  if (context.session) {
    return context.session;
  }

  const session = await auth.api.getSession({
    headers: event.headers,
    query: { disableRefresh: true },
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
 * The signed-in account with its role, whether it lost access
 * (users.access_revoked_at) and the kind of the member it acts for, in one
 * query. The flag and the kind stay out of AuthUserWithRole, so they never
 * reach a DTO. `image` is the stored photo's URL (user_avatars).
 */
async function loadUserWithRole(userId: string): Promise<{
  user: AuthUserWithRole;
  accessRevoked: boolean;
  memberKind: MemberKind | null;
} | null> {
  const row = await db.query.users.findFirst({
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
      accessRevokedAt: true,
    },
    with: {
      role: { columns: { id: true, name: true } },
      avatar: { columns: { file: true } },
      member: { columns: { kind: true } },
    },
  });
  if (!row) return null;
  const { accessRevokedAt, avatar, member, ...user } = row;
  return {
    user: { ...user, image: avatarUrl(avatar?.file) },
    accessRevoked: accessRevokedAt !== null,
    memberKind: user.memberId ? (member?.kind ?? null) : null,
  };
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
 * It also marks the real user as online (server/utils/live/online.ts).
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
  // The person at the keyboard is online, never the account an Admin acts
  // as (server/utils/live/online.ts).
  markSeen(realUser.id);

  const impersonated = await resolveImpersonation(event, {
    sessionId: session.session.id,
    realUser,
  });
  const user = impersonated?.user ?? realUser;

  context.realUser = realUser;
  context.impersonation = impersonated?.impersonation ?? null;
  context.user = user;
  context.role = user.role;
  // The kind read above is the signed-in user's: only theirs when they act
  // as themselves.
  if (!impersonated) context.memberKind = loaded.memberKind;

  return user;
}
