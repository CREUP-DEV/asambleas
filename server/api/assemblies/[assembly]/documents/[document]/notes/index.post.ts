import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { DocumentNoteDto } from "~~/shared/types/api";
import { documentNoteCreateBodySchema } from "~~/shared/utils/schemas/documentNotes";
import { createDocumentNote } from "../../../../../../utils/domain/documentNotes";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { throwMutationError } from "../../../../../../utils/errors";

/** The account writes a private note on a published document. */
export default defineEventHandler(async (event): Promise<DocumentNoteDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = await readBodyWith(event, documentNoteCreateBodySchema);
  try {
    return await createDocumentNote(event, ctx, body);
  } catch (error) {
    throwMutationError("documentNotes.create", error, event);
  }
});
