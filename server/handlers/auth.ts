import { defineEventHandler } from "h3";
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
 * The admin section (/api/admin): authenticated users only (401 without a
 * session). It filters by no permission key: each endpoint checks the one
 * it needs (`requireAnyPermission` or `requireAdmin` first thing; the
 * walk in adminEndpoints.test.ts fails a handler that skips it), and only
 * an Admin may give or take the Admin role or change that role's
 * permissions.
 *
 * So a stale tab gets the answer that makes it reload rather than a 403
 * from the account it no longer acts as:
 * - unsafe requests must name the effective user in `x-acting-user` (409
 *   `auth.identityChanged`);
 * - while an Admin acts as another account the whole section is read-only
 *   (403 `admin.impersonationReadOnly`): changes to users, roles, grants
 *   and links always carry the real Admin. Starting a second impersonation
 *   is refused here too.
 */
export default defineEventHandler(async (event) => {
  if (event.method === "OPTIONS") {
    return;
  }

  assertSameOriginMutation(event);
  await attachAuthContext(event);
  assertActingUser(event);
  assertNotImpersonatingMutation(event);
  ensureCsrfCookie(event);
  assertCsrfMutation(event);
});
