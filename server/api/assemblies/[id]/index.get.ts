import { defineEventHandler, createError } from "h3";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../utils/auth/requireAuth";
import { isAdmin } from "../../../utils/auth/rbac";
import { resolveAssemblyFromParam } from "../../../utils/routeResolvers";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import { ASSEMBLY_STATUSES } from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const assembly = await resolveAssemblyFromParam(event.context.params?.id);

  const canSeeDrafts =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  if (assembly.status === ASSEMBLY_STATUSES.DRAFT && !canSeeDrafts) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  return assembly;
});
