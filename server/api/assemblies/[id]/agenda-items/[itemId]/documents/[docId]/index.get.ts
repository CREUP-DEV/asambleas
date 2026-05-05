import { defineEventHandler, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../db";
import {
  agendaItems,
  assemblies,
  documents,
} from "../../../../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../../../../utils/auth/rbac";
import { validateCuid } from "../../../../../../../utils/validation";
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
  const docId = validateCuid(event.context.params?.docId, "Document ID");

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

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.agendaItemId, itemId)),
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
