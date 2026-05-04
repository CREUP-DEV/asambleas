import { defineEventHandler, setHeader } from "h3";
import { getAuthUserWithRole } from "../../utils/auth/requireAuth";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

export default defineEventHandler(async (event) => {
  setHeader(event, "cache-control", "no-store");

  const user = await getAuthUserWithRole(event);

  return {
    authenticated: true,
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
