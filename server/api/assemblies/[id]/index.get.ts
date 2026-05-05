import { defineEventHandler, createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { assemblies } from "../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../utils/auth/requireAuth";
import { isAdmin } from "../../../utils/auth/rbac";
import { validateCuid } from "../../../utils/validation";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const id = validateCuid(event.context.params?.id);

  const assembly = await db.query.assemblies.findFirst({
    where: eq(assemblies.id, id),
  });

  if (!assembly) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const canSeeDrafts =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  if (assembly.status === ASSEMBLY_STATUSES.DRAFT && !canSeeDrafts) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  return assembly;
});
