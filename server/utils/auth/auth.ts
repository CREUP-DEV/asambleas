import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  getOptionalConfigUrl,
  requireConfigString,
} from "~~/shared/utils/config";
import {
  SESSION_COOKIE_NAME_DEV,
  SESSION_COOKIE_NAME_PROD,
} from "~~/shared/constants/security";
import {
  AUDIT_ACTIONS,
  type ImpersonationEndReason,
} from "~~/shared/constants/activity";
import { db } from "../../db";
import { users, sessions, accounts, verifications } from "../../db/schema";
import { recordAudit } from "../domain/audit";
import { endImpersonations } from "./impersonation";
import { syncUserRole, type RoleSyncOutcome } from "./roleSync";
import { logError, logInfo } from "../core/logger";

// Traceability of the auth layer ----------------------------------------------

/**
 * The part of better-auth's endpoint context the hooks read. It is null
 * when a hook runs outside a request.
 */
export interface AuthHookContext {
  path?: string;
  headers?: Headers | null;
  request?: { headers?: Headers | null } | null;
}

/**
 * The client of the request behind a hook: the first X-Forwarded-For
 * address (the app runs behind a proxy) and the user agent. recordAudit
 * trims and truncates them.
 */
export function hookClientInfo(context: AuthHookContext | null | undefined): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const headers = context?.headers ?? context?.request?.headers ?? null;
  if (!headers) return { ipAddress: null, userAgent: null };
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: forwarded || headers.get("x-real-ip")?.trim() || null,
    userAgent: headers.get("user-agent") || null,
  };
}

/** How a deleted session ended, and what that does to its impersonations. */
export interface SessionEnd {
  action:
    | typeof AUDIT_ACTIONS.AUTH_SIGN_OUT
    | typeof AUDIT_ACTIONS.AUTH_SESSION_ENDED;
  /** `signed_out` (POST /api/auth/sign-out), `expired` or `revoked` (any other deletion). */
  reason: "signed_out" | "expired" | "revoked";
  /** The end reason of the impersonations the session held. */
  impersonationEnd: Extract<ImpersonationEndReason, "signed_out" | "expired">;
  /** Whether the request that deleted it is the user's own act (its IP is kept). */
  byRequest: boolean;
}

/**
 * Classifies a session deletion. The context alone does not say it: an
 * expired session is deleted inside get-session, with a request context.
 * Only the sign-out endpoint is a sign-out; an expired session ended on its
 * own; anything else (revoke-session and friends) revoked it.
 */
export function classifySessionEnd(
  session: { expiresAt: Date | string },
  context: AuthHookContext | null | undefined,
  now = new Date(),
): SessionEnd {
  if (context?.path === "/sign-out") {
    return {
      action: AUDIT_ACTIONS.AUTH_SIGN_OUT,
      reason: "signed_out",
      impersonationEnd: "signed_out",
      byRequest: true,
    };
  }
  if (new Date(session.expiresAt).getTime() <= now.getTime()) {
    return {
      action: AUDIT_ACTIONS.AUTH_SESSION_ENDED,
      reason: "expired",
      impersonationEnd: "expired",
      byRequest: false,
    };
  }
  return {
    action: AUDIT_ACTIONS.AUTH_SESSION_ENDED,
    reason: "revoked",
    impersonationEnd: "signed_out",
    byRequest: true,
  };
}

/** `user.created`: the first Google sign-in created the account. */
export async function recordUserCreated(
  user: { id: string; name?: string | null },
  context: AuthHookContext | null | undefined,
): Promise<void> {
  await recordAudit(db, {
    actor: { userId: user.id },
    source: "auth",
    action: AUDIT_ACTIONS.USER_CREATED,
    targetType: "user",
    targetId: user.id,
    after: { name: user.name ?? null },
    ...hookClientInfo(context),
  });
}

/**
 * `auth.sign_in`, with how role sync went. The session row already holds
 * the client as better-auth read it.
 */
export async function recordSignIn(
  session: {
    id: string;
    userId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  roleSync: RoleSyncOutcome,
): Promise<void> {
  await recordAudit(db, {
    actor: { userId: session.userId },
    source: "auth",
    action: AUDIT_ACTIONS.AUTH_SIGN_IN,
    targetType: "user",
    targetId: session.userId,
    after: { sessionId: session.id, roleSync },
    ipAddress: session.ipAddress ?? null,
    userAgent: session.userAgent ?? null,
  });
}

/**
 * A session ended: closes the impersonations it held (`signed_out`, or
 * `expired` with the session) and writes `auth.sign_out` or
 * `auth.session_ended`, in one transaction.
 */
export async function recordSessionEnd(
  session: { id: string; userId: string; expiresAt: Date | string },
  context: AuthHookContext | null | undefined,
  now = new Date(),
): Promise<void> {
  const end = classifySessionEnd(session, context, now);
  const client = end.byRequest
    ? hookClientInfo(context)
    : { ipAddress: null, userAgent: null };
  await db.transaction(async (tx) => {
    await endImpersonations(
      tx,
      { sessionId: session.id },
      end.impersonationEnd,
      client,
    );
    await recordAudit(tx, {
      actor: { userId: session.userId },
      source: "auth",
      action: end.action,
      targetType: "user",
      targetId: session.userId,
      after: { sessionId: session.id, reason: end.reason },
      ...client,
    });
  });
}

function getAuthBaseUrl() {
  return (
    getOptionalConfigUrl(process.env.BETTER_AUTH_URL, "BETTER_AUTH_URL") ||
    getOptionalConfigUrl(process.env.NUXT_SITE_URL, "NUXT_SITE_URL") ||
    undefined
  );
}

function getTrustedOrigins() {
  const origin = getAuthBaseUrl();
  return origin ? [origin] : [];
}

const isProd = process.env.NODE_ENV === "production";

/**
 * Self-service account endpoints that better-auth exposes by default. Names
 * and emails come from Google and the intranet role sync, and the history
 * shows users.name as the actor, so nobody may rename, re-email or delete
 * their own account. The app only uses sign-in, the OAuth callback, sign-out
 * and get-session. better-auth compares these exactly against the path under
 * /api/auth, so each one is listed on its own.
 */
const DISABLED_AUTH_PATHS = [
  "/update-user",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/update-session",
];

export const auth = betterAuth({
  baseURL: getAuthBaseUrl(),
  disabledPaths: DISABLED_AUTH_PATHS,
  secret: requireConfigString(process.env.APP_SECRET, "APP_SECRET"),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  account: {
    encryptOAuthTokens: true,
  },
  emailAndPassword: {
    enabled: false,
  },
  socialProviders: {
    google: {
      clientId: requireConfigString(
        process.env.GOOGLE_CLIENT_ID,
        "GOOGLE_CLIENT_ID",
      ),
      clientSecret: requireConfigString(
        process.env.GOOGLE_CLIENT_SECRET,
        "GOOGLE_CLIENT_SECRET",
      ),
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },
  advanced: {
    cookies: {
      session_token: {
        name: isProd ? SESSION_COOKIE_NAME_PROD : SESSION_COOKIE_NAME_DEV,
        attributes: {
          httpOnly: true,
          secure: isProd,
          sameSite: "lax" as const,
          path: "/",
        },
      },
    },
  },
  // Run after better-auth's transaction commits. Each one catches its own
  // errors: a failed sync or audit row never blocks signing in or out.
  databaseHooks: {
    user: {
      create: {
        after: async (user, context) => {
          try {
            await recordUserCreated(user, context);
          } catch (error) {
            logError("auth.hook.userCreated", error);
          }
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          let roleSync: RoleSyncOutcome = "failed";
          try {
            roleSync = await syncUserRole(session.userId);
            logInfo("auth.hook", {
              action: "roleSync",
              userId: session.userId,
              outcome: roleSync,
            });
          } catch (error) {
            logError("auth.hook.roleSync", error);
          }
          try {
            await recordSignIn(session, roleSync);
          } catch (error) {
            logError("auth.hook.signIn", error);
          }
        },
      },
      delete: {
        after: async (session, context) => {
          try {
            await recordSessionEnd(session, context);
          } catch (error) {
            logError("auth.hook.sessionEnd", error);
          }
        },
      },
    },
  },
  trustedOrigins: getTrustedOrigins(),
});

export type Session = typeof auth.$Infer.Session;
