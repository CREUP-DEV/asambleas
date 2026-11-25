import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import {
  requestDocumentCorrection,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";
import { correctionBodySchema } from "~~/shared/utils/schemas/document";

/** The Secretaría sends a presented document back to draft with a note. */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = await readBodyWith(event, correctionBodySchema);
  return requestDocumentCorrection(ctx, body);
});
