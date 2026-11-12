import { defineEventHandler, readBody } from "h3";
import {
  parseDocumentBody,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { recordDocumentReading } from "../../../../../utils/domain/documentViews";
import type { DocumentReadingDto } from "~~/shared/types/api";
import { documentReadingSchema } from "~~/shared/utils/schemas/document";

/**
 * A beat of an open published document: a view and the seconds it was
 * read, for the statistics. Anyone who sees the document; nothing is kept
 * while an Admin acts as the account.
 */
export default defineEventHandler(
  async (event): Promise<DocumentReadingDto> => {
    const ctx = await resolveDocumentRoute(event);
    const body = parseDocumentBody(
      documentReadingSchema,
      await readBody(event),
    );
    return recordDocumentReading(ctx, body);
  },
);
