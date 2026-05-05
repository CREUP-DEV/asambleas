import { defineEventHandler, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import {
  agendaItems,
  assemblies,
  documents,
} from "../../../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../../../utils/auth/rbac";
import { validateCuid } from "../../../../../../utils/validation";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ASSEMBLY_STATUSES,
  DOCUMENT_STATUSES,
} from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const assemblyId = validateCuid(event.context.params?.id, "Assembly ID");
  const itemId = validateCuid(event.context.params?.itemId, "Item ID");

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

  const item = await db.query.agendaItems.findFirst({
    where: and(
      eq(agendaItems.id, itemId),
      eq(agendaItems.assemblyId, assemblyId),
    ),
    columns: { id: true },
  });

  if (!item) {
    throw createError({ statusCode: 404, message: "Punto no encontrado" });
  }

  const allDocs = await db.query.documents.findMany({
    where: eq(documents.agendaItemId, itemId),
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
