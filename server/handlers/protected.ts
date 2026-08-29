import { defineEventHandler } from "h3";
import { attachAuthContext } from "../utils/auth/rbac";
import {
  assertSameOriginMutation,
  ensureCsrfCookie,
  assertCsrfMutation,
} from "../utils/auth/requestProtection";

/**
 * Authenticated, non-admin API surface. Mirrors `handlers/auth.ts` without the
 * admin gate: each endpoint enforces its own permission. Running
 * `ensureCsrfCookie` here means any GET in the section hands out the token its
 * mutations require, so no endpoint has to issue the cookie by itself.
 */
export default defineEventHandler(async (event) => {
  if (event.method === "OPTIONS") {
    return;
  }

  assertSameOriginMutation(event);
  await attachAuthContext(event);
  ensureCsrfCookie(event);
  assertCsrfMutation(event);
});
