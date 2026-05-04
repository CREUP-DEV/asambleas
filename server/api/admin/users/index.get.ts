import { createError, defineEventHandler, getQuery } from "h3";
import { z } from "zod/v4";
import { db } from "../../../db";
import { requireAdmin } from "../../../utils/auth/rbac";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export default defineEventHandler(async (event) => {
  await requireAdmin(event);

  const parsed = querySchema.safeParse(getQuery(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Paginación inválida" });
  }

  const { page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;

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
    limit: pageSize + 1,
    offset,
  });

  const hasNextPage = users.length > pageSize;
  const data = hasNextPage ? users.slice(0, pageSize) : users;

  return {
    data,
    pagination: {
      page,
      pageSize,
      hasNextPage,
      hasPreviousPage: page > 1,
    },
  };
});
