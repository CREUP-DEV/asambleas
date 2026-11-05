import { defineEventHandler, readBody } from "h3";
import {
  parseDocumentBody,
  requestDocumentCorrection,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";
import { correctionBodySchema } from "~~/shared/utils/schemas/document";

/** The Secretaría sends a presented document back to draft with a note. */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = parseDocumentBody(correctionBodySchema, await readBody(event));
  return requestDocumentCorrection(ctx, body);
});
