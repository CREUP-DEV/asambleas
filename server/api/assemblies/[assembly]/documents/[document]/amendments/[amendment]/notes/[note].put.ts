import { readBodyWith } from "../../../../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { AmendmentNoteDto } from "~~/shared/types/api";
import { amendmentNoteUpdateBodySchema } from "~~/shared/utils/schemas/amendmentNotes";
import { updateAmendmentNote } from "../../../../../../../../utils/domain/amendmentNotes";
import { loadAmendmentContext } from "../../../../../../../../utils/domain/amendments";
import { throwMutationError } from "../../../../../../../../utils/errors";
import { validateCuid } from "../../../../../../../../utils/validation";

/** The account changes the text of one of its notes on the amendment. */
export default defineEventHandler(async (event): Promise<AmendmentNoteDto> => {
  const ctx = await loadAmendmentContext(event);
  const noteId = validateCuid(getRouterParam(event, "note"), "Nota");
  const body = await readBodyWith(event, amendmentNoteUpdateBodySchema, {
    empty: {},
  });
  try {
    return await updateAmendmentNote(event, ctx, noteId, body);
  } catch (error) {
    throwMutationError("amendmentNotes.update", error, event);
  }
});
