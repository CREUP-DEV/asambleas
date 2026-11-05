import { defineEventHandler } from "h3";
import { getAuthUserWithRole } from "../../utils/auth/requireAuth";
import { stopImpersonation } from "../../utils/auth/impersonation";

/**
 * The Admin goes back to their own account: closes the impersonation the
 * request runs under (`stopped`) and writes `impersonation.stop`. 409
 * `impersonation.errors.notActive` when there is none (it expired or was
 * stopped in another tab). It lives under /api/me, not /api/admin, since
 * the section gate there checks the account acted as. The section handler
 * exempts it from the `x-acting-user` check, so stopping always works. The
 * client reloads afterwards.
 */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
  await getAuthUserWithRole(event);
  await stopImpersonation(event);
  return { success: true };
});
