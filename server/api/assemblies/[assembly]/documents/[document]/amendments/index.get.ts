import { createError, defineEventHandler, getQuery } from "h3";
import type {
  DocumentAmendmentsDto,
  PartialDocumentAmendmentsDto,
} from "~~/shared/types/api";
import { parseAmendmentIdsQuery } from "~~/shared/utils/partialAmendments";
import {
  listDocumentAmendments,
  listDocumentAmendmentsByIds,
  loadAmendmentDocumentContext,
} from "../../../../../../utils/domain/amendments";
import { requireViewer } from "../../../../../../utils/domain/roomView";

/**
 * Amendments the actor can see, with their relations. With `?ids=a,b` (at
 * most PARTIAL_AMENDMENTS_MAX), only those and the ones whose DTO reads
 * them, plus the ids no longer there (PartialDocumentAmendmentsDto).
 */
export default defineEventHandler(
  async (
    event,
  ): Promise<DocumentAmendmentsDto | PartialDocumentAmendmentsDto> => {
    // First: with `?view=room` the context loads as the room viewer.
    await requireViewer(event);
    const ctx = await loadAmendmentDocumentContext(event);
    const ids = parseAmendmentIdsQuery(getQuery(event).ids);
    if (ids === null) {
      throw createError({ statusCode: 400, message: "Parámetros no válidos" });
    }
    return ids
      ? listDocumentAmendmentsByIds(ctx, ids)
      : listDocumentAmendments(ctx);
  },
);
