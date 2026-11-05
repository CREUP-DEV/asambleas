import { defineEventHandler, type H3Event } from "h3";
import { attachAuthContext } from "../utils/auth/rbac";
import {
  assertActingUser,
  assertNotImpersonatingMutation,
} from "../utils/auth/impersonation";
import {
  assertSameOriginMutation,
  ensureCsrfCookie,
  assertCsrfMutation,
} from "../utils/auth/requestProtection";

/**
 * The full request path as h3 routes it: the original URL (inside a
 * prefixed middleware `event.path` has the prefix sliced off, and this
 * handler serves several prefixes), decoded like h3 decodes it before
 * matching prefixes and routes (encoded slashes and `%25` stay encoded),
 * without the query, with repeated slashes collapsed.
 */
export function requestPathname(event: H3Event): string {
  const raw = event.node.req.originalUrl || event.path || "/";
  const queryAt = raw.search(/[?#]/);
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  return decodePath(path).replace(/[/\\]+/g, "/") || "/";
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(
      path.replace(/%25/g, "%2525").replace(/%2F/gi, "%252F"),
    );
  } catch {
    return path;
  }
}

/**
 * Members (/api/members/**): read-only while an Admin acts as another
 * account, like the admin section. Compared case-insensitively, so the
 * check can only ever cover more.
 */
export function isMembersPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === "/api/members" || path.startsWith("/api/members/");
}

/**
 * DELETE /api/me/impersonation: going back to one's own account works
 * whatever identity the tab believes it has, so it skips the
 * `x-acting-user` check (never the same-origin or CSRF checks).
 */
export function isStopImpersonationRequest(
  method: string,
  pathname: string,
): boolean {
  return (
    method.toUpperCase() === "DELETE" &&
    pathname.replace(/\/+$/, "") === "/api/me/impersonation"
  );
}

/**
 * Authenticated, non-admin API surface. Mirrors `handlers/auth.ts` without the
 * admin gate: each endpoint enforces its own permission. Running
 * `ensureCsrfCookie` here means any GET in the section hands out the token its
 * mutations require, so no endpoint has to issue the cookie by itself.
 *
 * Unsafe requests must also name the effective user in `x-acting-user`
 * (409 `auth.identityChanged` otherwise, and the client reloads): while an
 * Admin impersonates, identity can switch under an open tab. Members are
 * read-only while impersonating (403 `admin.impersonationReadOnly`).
 */
export default defineEventHandler(async (event) => {
  if (event.method === "OPTIONS") {
    return;
  }

  assertSameOriginMutation(event);
  await attachAuthContext(event);
  ensureCsrfCookie(event);
  assertCsrfMutation(event);

  const pathname = requestPathname(event);
  if (!isStopImpersonationRequest(event.method, pathname)) {
    assertActingUser(event);
  }
  if (isMembersPath(pathname)) {
    assertNotImpersonatingMutation(event);
  }
});
