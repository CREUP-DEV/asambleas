import { defineEventHandler } from "h3";
import type { AmendmentNotesDto } from "~~/shared/types/api";
import { listAmendmentNotes } from "../../../../../../../../utils/domain/amendmentNotes";
import { loadAmendmentContext } from "../../../../../../../../utils/domain/amendments";

/** The account's own private notes on the amendment. */
export default defineEventHandler(async (event): Promise<AmendmentNotesDto> =>
  listAmendmentNotes(await loadAmendmentContext(event)),
);
