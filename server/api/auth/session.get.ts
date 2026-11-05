import { defineEventHandler, setHeader } from "h3";
import {
  getAuthUserWithRole,
  type AuthEventContext,
} from "../../utils/auth/requireAuth";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

/**
 * Whether the request is signed in, for the global auth middleware. `user`
 * is the effective user: the account acted as while an Admin impersonates
 * it (`impersonating`), so `isAdmin` is false then. The rest of the
 * identity, the Admin's name included, comes from GET /api/me.
 */
export default defineEventHandler(async (event) => {
  setHeader(event, "cache-control", "no-store");

  const user = await getAuthUserWithRole(event);
  const impersonating = Boolean(
    (event.context as AuthEventContext).impersonation,
  );

  return {
    authenticated: true,
    impersonating,
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          university: user.university,
          initials: user.externalInitials,
          role: user.role?.name ?? null,
          isAdmin: user.role?.name === SYSTEM_ROLES.ADMIN,
        }
      : null,
  };
});
