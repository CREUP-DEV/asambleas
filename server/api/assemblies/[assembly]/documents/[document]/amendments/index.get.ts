import { defineEventHandler } from "h3";
import type { DocumentAmendmentsDto } from "~~/shared/types/api";
import {
  listDocumentAmendments,
  loadAmendmentDocumentContext,
} from "../../../../../../utils/domain/amendments";
import { requireViewer } from "../../../../../../utils/domain/roomView";

/** Amendments the actor can see, with their relations. */
export default defineEventHandler(
  async (event): Promise<DocumentAmendmentsDto> => {
    // First: with `?view=room` the context loads as the room viewer.
    await requireViewer(event);
    const ctx = await loadAmendmentDocumentContext(event);
    return listDocumentAmendments(ctx);
  },
);
