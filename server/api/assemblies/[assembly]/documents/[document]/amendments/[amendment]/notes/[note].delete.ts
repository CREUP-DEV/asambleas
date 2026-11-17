import { defineEventHandler, getRouterParam } from "h3";
import { deleteAmendmentNote } from "../../../../../../../../utils/domain/amendmentNotes";
import { loadAmendmentContext } from "../../../../../../../../utils/domain/amendments";
import { throwMutationError } from "../../../../../../../../utils/errors";
import { validateCuid } from "../../../../../../../../utils/validation";

/** The account deletes one of its notes on the amendment. */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const ctx = await loadAmendmentContext(event);
  const noteId = validateCuid(getRouterParam(event, "note"), "Nota");
  try {
    await deleteAmendmentNote(event, ctx, noteId);
    return { success: true };
  } catch (error) {
    throwMutationError("amendmentNotes.delete", error, event);
  }
});
