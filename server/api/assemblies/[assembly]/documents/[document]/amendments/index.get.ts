import { defineEventHandler } from "h3";
import type { DocumentAmendmentsDto } from "~~/shared/types/api";
import {
  listDocumentAmendments,
  loadAmendmentDocumentContext,
} from "../../../../../../utils/domain/amendments";

/** Amendments the actor can see, with their relations. */
export default defineEventHandler(
  async (event): Promise<DocumentAmendmentsDto> => {
    const ctx = await loadAmendmentDocumentContext(event);
    return listDocumentAmendments(ctx);
  },
);
