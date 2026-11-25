import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import {
  resolveDocumentRoute,
  submitDocument,
} from "../../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";
import { documentActionSchema } from "~~/shared/utils/schemas/document";

export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = await readBodyWith(event, documentActionSchema);
  return submitDocument(ctx, body);
});
