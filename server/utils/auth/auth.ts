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
import { db } from "../../db";
import { users, sessions, accounts, verifications } from "../../db/schema";
import { syncUserRole } from "./roleSync";
import { logError, logInfo } from "../core/logger";

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

export const auth = betterAuth({
  baseURL: getAuthBaseUrl(),
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
          sameSite: "strict" as const,
          path: "/",
        },
      },
    },
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          try {
            await syncUserRole(session.userId);
            logInfo("auth.hook", {
              action: "roleSync",
              userId: session.userId,
            });
          } catch (error) {
            logError("auth.hook.roleSync", error);
          }
        },
      },
    },
  },
  trustedOrigins: getTrustedOrigins(),
});

export type Session = typeof auth.$Infer.Session;
