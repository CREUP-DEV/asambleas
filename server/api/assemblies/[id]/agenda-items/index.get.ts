import { defineEventHandler } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { agendaItems, assemblies } from "../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../utils/auth/rbac";
import { validateCuid } from "../../../../utils/validation";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const assemblyId = validateCuid(event.context.params?.id, "Assembly ID");

  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, assemblyId),
    columns: { id: true, status: true },
  });

  if (!assembly) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const canSeeDrafts =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  if (assembly.status === ASSEMBLY_STATUSES.DRAFT && !canSeeDrafts) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const items = await db.query.agendaItems.findMany({
    where: eq(agendaItems.assemblyId, assemblyId),
    orderBy: (t, { asc }) => [asc(t.order)],
  });

  return items;
});
