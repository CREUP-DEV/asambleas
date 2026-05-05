import { defineEventHandler, getQuery, createError } from "h3";
import { z } from "zod/v4";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { assemblies } from "../../db/schema";
import { requireAuth, getAuthUserWithRole } from "../../utils/auth/requireAuth";
import { isAdmin } from "../../utils/auth/rbac";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["draft", "provisional", "definitive"]).optional(),
});

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const parsed = querySchema.safeParse(getQuery(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Parámetros inválidos" });
  }

  const { page, pageSize, status } = parsed.data;
  const offset = (page - 1) * pageSize;

  const canSeeDrafts =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  if (status === ASSEMBLY_STATUSES.DRAFT && !canSeeDrafts) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para ver borradores",
    });
  }

  const conditions = [
    status ? eq(assemblies.status, status) : undefined,
    !canSeeDrafts ? ne(assemblies.status, ASSEMBLY_STATUSES.DRAFT) : undefined,
  ].filter(Boolean);

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db.query.assemblies.findMany({
    where,
    orderBy: [desc(assemblies.startDate)],
    limit: pageSize + 1,
    offset,
  });

  const hasNextPage = rows.length > pageSize;
  const data = hasNextPage ? rows.slice(0, pageSize) : rows;

  return {
    data,
    pagination: { page, pageSize, hasNextPage, hasPreviousPage: page > 1 },
  };
});
