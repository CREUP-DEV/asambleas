import { defineEventHandler, readBody } from "h3";
import {
  parseDocumentBody,
  resolveDocumentRoute,
  updateDocumentContent,
} from "../../../../../utils/domain/documents";
import { assertImagesBelong } from "../../../../../utils/domain/documentImages";
import type { DocumentDto } from "~~/shared/types/api";
import { documentContentSchema } from "~~/shared/utils/schemas/document";

export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = parseDocumentBody(documentContentSchema, await readBody(event));
  // Its images are ones stored for this document.
  await assertImagesBelong(ctx.document.id, body.blocks);
  return updateDocumentContent(ctx, body);
});
