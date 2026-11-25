import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import {
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
  const body = await readBodyWith(event, positionsPublicationBodySchema);
  return setPositionsPublication(ctx, body);
});
