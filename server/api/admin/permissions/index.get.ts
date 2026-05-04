import { defineEventHandler } from "h3";
import { db } from "../../../db";

export default defineEventHandler(async () => {
  const allPermissions = await db.query.permissions.findMany({
    columns: {
      id: true,
      key: true,
      description: true,
    },
    orderBy: (p, { asc }) => [asc(p.key)],
  });

  return { data: allPermissions };
});
