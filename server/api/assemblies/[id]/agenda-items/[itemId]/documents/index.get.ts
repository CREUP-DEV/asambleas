import { defineEventHandler, createError } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { documents } from "../../../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../../../utils/auth/rbac";
import {
  resolveAgendaItemFromParam,
  resolveAssemblyFromParam,
} from "../../../../../../utils/routeResolvers";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ASSEMBLY_STATUSES,
  DOCUMENT_STATUSES,
} from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const assembly = await resolveAssemblyFromParam(event.context.params?.id);

  const canSeeDrafts =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  if (assembly.status === ASSEMBLY_STATUSES.DRAFT && !canSeeDrafts) {
    throw createError({ statusCode: 404, message: "Asamblea no encontrada" });
  }

  const item = await resolveAgendaItemFromParam(
    assembly.id,
    event.context.params?.itemId,
  );

  const allDocs = await db.query.documents.findMany({
    where: eq(documents.agendaItemId, item.id),
    with: {
      submittedByUser: {
        columns: { id: true, name: true, email: true, externalInitials: true },
      },
    },
    orderBy: (d, { asc }) => [asc(d.createdAt)],
  });

  const canReview =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  const visibleDocs = canSeeDrafts
    ? allDocs
    : allDocs.filter(
        (d) =>
          d.status === DOCUMENT_STATUSES.ACCEPTED ||
          (canReview && d.status === DOCUMENT_STATUSES.PENDING_REVIEW) ||
          (d.submittedBy !== null && d.submittedBy === user?.id),
      );

  return visibleDocs;
});
