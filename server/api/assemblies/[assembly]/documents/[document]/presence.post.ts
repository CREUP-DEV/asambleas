import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import { resolveDocumentRoute } from "../../../../../utils/domain/documents";
import { documentPresence } from "../../../../../utils/domain/documentPresence";
import type { DocumentPresenceDto } from "~~/shared/types/api";
import { documentPresenceSchema } from "~~/shared/utils/schemas/document";

export default defineEventHandler(
  async (event): Promise<DocumentPresenceDto> => {
    const ctx = await resolveDocumentRoute(event);
    const body = await readBodyWith(event, documentPresenceSchema);
    return documentPresence(ctx, body);
  },
);
