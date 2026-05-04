import { defineEventHandler } from "h3";
import { db } from "../../../db";

export default defineEventHandler(async () => {
  const allRoles = await db.query.roles.findMany({
    columns: {
      id: true,
      name: true,
      description: true,
      isSystem: true,
    },
    orderBy: (r, { asc }) => [asc(r.name)],
  });

  return { data: allRoles };
});
