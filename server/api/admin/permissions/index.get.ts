import { defineEventHandler } from "h3";
import { db } from "../../../db";
import { requireAdmin } from "../../../utils/auth/rbac";

export default defineEventHandler(async (event) => {
  await requireAdmin(event);

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
