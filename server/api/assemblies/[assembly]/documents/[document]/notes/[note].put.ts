import { defineEventHandler, getRouterParam, readBody } from "h3";
import type { DocumentNoteDto } from "~~/shared/types/api";
import { documentNoteUpdateBodySchema } from "~~/shared/utils/schemas/documentNotes";
import { updateDocumentNote } from "../../../../../../utils/domain/documentNotes";
import {
  parseDocumentBody,
  resolveDocumentRoute,
} from "../../../../../../utils/domain/documents";
import { throwMutationError } from "../../../../../../utils/errors";
import { validateCuid } from "../../../../../../utils/validation";

/** The account changes the text of one of its private notes. */
export default defineEventHandler(async (event): Promise<DocumentNoteDto> => {
  const ctx = await resolveDocumentRoute(event);
  const noteId = validateCuid(getRouterParam(event, "note"), "Nota");
  const body = parseDocumentBody(
    documentNoteUpdateBodySchema,
    await readBody(event),
  );
  try {
    return await updateDocumentNote(event, ctx, noteId, body);
  } catch (error) {
    throwMutationError("documentNotes.update", error, event);
  }
});
