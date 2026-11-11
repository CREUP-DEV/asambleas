import { defineEventHandler, getRouterParam } from "h3";
import { deleteDocumentNote } from "../../../../../../utils/domain/documentNotes";
import { resolveDocumentRoute } from "../../../../../../utils/domain/documents";
import { throwMutationError } from "../../../../../../utils/errors";
import { validateCuid } from "../../../../../../utils/validation";

/** The account deletes one of its private notes. */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const ctx = await resolveDocumentRoute(event);
  const noteId = validateCuid(getRouterParam(event, "note"), "Nota");
  try {
    await deleteDocumentNote(event, ctx, noteId);
    return { success: true };
  } catch (error) {
    throwMutationError("documentNotes.delete", error, event);
  }
});
