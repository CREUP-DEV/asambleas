import { defineEventHandler, readBody } from "h3";
import {
  parseDocumentBody,
  resolveDocumentRoute,
  updateDocument,
} from "../../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";
import { documentUpdateSchema } from "~~/shared/utils/schemas/document";

export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = parseDocumentBody(documentUpdateSchema, await readBody(event));
  return updateDocument(ctx, body);
});
