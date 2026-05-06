import { defineEventHandler, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../../db";
import { amendments, documents } from "../../../../../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../../../../../utils/auth/rbac";
import {
  resolveAgendaItemFromParam,
  resolveAssemblyFromParam,
} from "../../../../../../../../utils/routeResolvers";
import { validateCuid } from "../../../../../../../../utils/validation";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  AMENDMENT_STATUSES,
  type AmendmentStatus,
} from "~~/shared/constants/statuses";

const PRIVATE_STATUSES: AmendmentStatus[] = [
  AMENDMENT_STATUSES.DRAFT,
  AMENDMENT_STATUSES.PENDING_REVIEW,
];

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const docId = validateCuid(event.context.params?.docId, "Document ID");
  const assembly = await resolveAssemblyFromParam(event.context.params?.id);
  const item = await resolveAgendaItemFromParam(
    assembly.id,
    event.context.params?.itemId,
  );

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.agendaItemId, item.id)),
    columns: { id: true, agendaItemId: true },
  });

  if (!doc) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  const canSeeAll =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  const allAmendments = await db.query.amendments.findMany({
    where: eq(amendments.documentId, docId),
    with: {
      author: {
        columns: {
          id: true,
          name: true,
          email: true,
          externalInitials: true,
        },
      },
    },
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });

  if (canSeeAll) {
    return allAmendments;
  }

  const amendmentById = new Map(
    allAmendments.map((amendment) => [amendment.id, amendment]),
  );
  const isChainAuthor = (
    amendment: (typeof allAmendments)[number],
    userId: string | undefined,
  ) => {
    if (!userId) return false;
    let cursor: typeof amendment | undefined = amendment;
    while (cursor) {
      if (cursor.submittedBy === userId) return true;
      cursor = cursor.parentAmendmentId
        ? amendmentById.get(cursor.parentAmendmentId)
        : undefined;
    }
    return false;
  };

  return allAmendments.filter((amendment) => {
    if (!PRIVATE_STATUSES.includes(amendment.status as AmendmentStatus)) {
      return true;
    }
    return isChainAuthor(amendment, user?.id);
  });
});
