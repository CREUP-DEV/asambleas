import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { DocumentAmendmentsDto } from "~~/shared/types/api";
import { validateAmendmentsBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentDocumentContext,
  validateAmendments,
} from "../../../../../../utils/domain/amendments";

/** The Secretaría validates presented amendments, optionally publishing them. */
export default defineEventHandler(
  async (event): Promise<DocumentAmendmentsDto> => {
    const ctx = await loadAmendmentDocumentContext(event);
    const body = await readBodyWith(event, validateAmendmentsBodySchema, {
      empty: {},
    });
    return validateAmendments(ctx, body);
  },
);
