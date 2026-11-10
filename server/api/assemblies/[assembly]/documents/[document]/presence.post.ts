import { defineEventHandler, readBody } from "h3";
import {
  parseDocumentBody,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { documentPresence } from "../../../../../utils/domain/documentPresence";
import type { DocumentPresenceDto } from "~~/shared/types/api";
import { documentPresenceSchema } from "~~/shared/utils/schemas/document";

export default defineEventHandler(
  async (event): Promise<DocumentPresenceDto> => {
    const ctx = await resolveDocumentRoute(event);
    const body = parseDocumentBody(
      documentPresenceSchema,
      await readBody(event),
    );
    return documentPresence(ctx, body);
  },
);
