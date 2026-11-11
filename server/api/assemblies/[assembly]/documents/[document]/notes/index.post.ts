import { defineEventHandler, readBody } from "h3";
import type { DocumentNoteDto } from "~~/shared/types/api";
import { documentNoteCreateBodySchema } from "~~/shared/utils/schemas/documentNotes";
import { createDocumentNote } from "../../../../../../utils/domain/documentNotes";
import {
  parseDocumentBody,
  resolveDocumentRoute,
} from "../../../../../../utils/domain/documents";
import { throwMutationError } from "../../../../../../utils/errors";

/** The account writes a private note on a published document. */
export default defineEventHandler(async (event): Promise<DocumentNoteDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = parseDocumentBody(
    documentNoteCreateBodySchema,
    await readBody(event),
  );
  try {
    return await createDocumentNote(event, ctx, body);
  } catch (error) {
    throwMutationError("documentNotes.create", error, event);
  }
});
