import { defineEventHandler, setHeader } from "h3";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../utils/auth/requireAuth";
import { db } from "../../db";
import { users } from "../../db/schema";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event);
  setHeader(event, "cache-control", "no-store");

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      roleId: true,
      university: true,
      externalInitials: true,
    },
    with: {
      role: { columns: { id: true, name: true } },
    },
  });

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
