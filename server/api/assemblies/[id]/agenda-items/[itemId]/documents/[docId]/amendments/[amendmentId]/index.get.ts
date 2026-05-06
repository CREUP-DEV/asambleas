import { defineEventHandler, createError } from "h3";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../../../../../db";
import { amendments } from "../../../../../../../../../db/schema";
import {
  requireAuth,
  getAuthUserWithRole,
} from "../../../../../../../../../utils/auth/requireAuth";
import { isAdmin } from "../../../../../../../../../utils/auth/rbac";
import { validateCuid } from "../../../../../../../../../utils/validation";
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
  const amendmentId = validateCuid(
    event.context.params?.amendmentId,
    "Amendment ID",
  );

  const amendment = await db.query.amendments.findFirst({
    where: and(
      eq(amendments.id, amendmentId),
      eq(amendments.documentId, docId),
    ),
    with: {
      author: {
        columns: {
          id: true,
          name: true,
          email: true,
          externalInitials: true,
        },
      },
      parent: {
        columns: { id: true, status: true, submittedBy: true },
      },
      children: {
        columns: { id: true, status: true, submittedBy: true, createdAt: true },
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      },
    },
  });

  if (!amendment) {
    throw createError({ statusCode: 404, message: "Enmienda no encontrada" });
  }

  const canSeeAll =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  const chain = await db.query.amendments.findMany({
    where: eq(amendments.documentId, docId),
    columns: { id: true, submittedBy: true, parentAmendmentId: true },
  });
  const chainById = new Map(chain.map((entry) => [entry.id, entry]));
  let cursor = chainById.get(amendment.id);
  let isChainAuthor = false;
  while (cursor) {
    if (cursor.submittedBy === user?.id) {
      isChainAuthor = true;
      break;
    }
    cursor = cursor.parentAmendmentId
      ? chainById.get(cursor.parentAmendmentId)
      : undefined;
  }

  if (
    !canSeeAll &&
    PRIVATE_STATUSES.includes(amendment.status as AmendmentStatus) &&
    !isChainAuthor
  ) {
    throw createError({ statusCode: 404, message: "Enmienda no encontrada" });
  }

  return amendment;
});
