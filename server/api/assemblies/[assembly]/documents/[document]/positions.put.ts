import { defineEventHandler, readBody } from "h3";
import {
  parseDocumentBody,
  resolveDocumentRoute,
  setPositionsPublication,
} from "../../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";
import { positionsPublicationBodySchema } from "~~/shared/utils/schemas/document";

/**
 * The Secretaría makes the main presenter's answers to the amendments
 * public before their debate, or takes that back while the debate has not
 * started.
 */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = parseDocumentBody(
    positionsPublicationBodySchema,
    await readBody(event),
  );
  return setPositionsPublication(ctx, body);
});
