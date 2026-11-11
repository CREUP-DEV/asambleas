import { defineEventHandler } from "h3";
import type { DocumentNotesDto } from "~~/shared/types/api";
import { listDocumentNotes } from "../../../../../../utils/domain/documentNotes";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";

/** The account's own private notes on the document. */
export default defineEventHandler(async (event): Promise<DocumentNotesDto> =>
  listDocumentNotes(await resolveDocumentRoute(event)),
);
