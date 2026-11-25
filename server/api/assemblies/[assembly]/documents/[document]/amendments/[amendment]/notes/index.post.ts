import { readBodyWith } from "../../../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AmendmentNoteDto } from "~~/shared/types/api";
import { amendmentNoteCreateBodySchema } from "~~/shared/utils/schemas/amendmentNotes";
import { createAmendmentNote } from "../../../../../../../../utils/domain/amendmentNotes";
import { loadAmendmentContext } from "../../../../../../../../utils/domain/amendments";
import { throwMutationError } from "../../../../../../../../utils/errors";

/** The account writes a private note on an amendment it reads. */
export default defineEventHandler(async (event): Promise<AmendmentNoteDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readBodyWith(event, amendmentNoteCreateBodySchema, {
    empty: {},
  });
  try {
    return await createAmendmentNote(event, ctx, body);
  } catch (error) {
    throwMutationError("amendmentNotes.create", error, event);
  }
});
