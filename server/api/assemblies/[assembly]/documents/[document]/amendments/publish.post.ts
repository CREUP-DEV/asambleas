import { defineEventHandler } from "h3";
import type { DocumentAmendmentsDto } from "~~/shared/types/api";
import { publishAmendmentsBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentDocumentContext,
  publishAmendments,
  readAmendmentBody,
} from "../../../../../../utils/domain/amendments";

/** The Secretaría makes validated amendments visible to everyone. */
export default defineEventHandler(
  async (event): Promise<DocumentAmendmentsDto> => {
    const ctx = await loadAmendmentDocumentContext(event);
    const body = await readAmendmentBody(event, publishAmendmentsBodySchema);
    return publishAmendments(ctx, body);
  },
);
