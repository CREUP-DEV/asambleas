import { defineEventHandler } from "h3";
import { db } from "../../../db";

export default defineEventHandler(async () => {
  const users = await db.query.users.findMany({
    columns: {
      id: true,
      name: true,
      email: true,
      image: true,
      roleId: true,
      externalRole: true,
      externalName: true,
      externalInitials: true,
      university: true,
      lastRoleSyncAt: true,
      createdAt: true,
    },
    with: {
      role: { columns: { id: true, name: true } },
    },
    orderBy: (u, { asc }) => [asc(u.name)],
  });

  return { data: users };
});
