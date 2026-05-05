import { defineEventHandler, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../db";
import { documents } from "../../../../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../../../../utils/auth/rbac";
import {
  resolveAgendaItemFromParam,
  resolveAssemblyFromParam,
} from "../../../../../../../utils/routeResolvers";
import { validateCuid } from "../../../../../../../utils/validation";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ASSEMBLY_STATUSES,
  DOCUMENT_STATUSES,
} from "~~/shared/constants/statuses";

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const docId = validateCuid(event.context.params?.docId, "Document ID");
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

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.agendaItemId, item.id)),
    with: {
      submittedByUser: {
        columns: { id: true, name: true, email: true, externalInitials: true },
      },
      proponent: {
        columns: { id: true, name: true, email: true, externalInitials: true },
      },
    },
  });

  if (!doc) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  const canSeeDocument =
    doc.status === DOCUMENT_STATUSES.ACCEPTED ||
    canSeeDrafts ||
    (doc.submittedBy !== null && doc.submittedBy === user?.id);

  if (!canSeeDocument) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  return doc;
});
