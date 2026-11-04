import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { amendmentUpdateBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentContext,
  readAmendmentBody,
  updateAmendmentDraft,
} from "../../../../../../../utils/domain/amendments";

/** Edits a draft amendment. Requires the `updatedAt` the client last saw. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readAmendmentBody(event, amendmentUpdateBodySchema);
  return updateAmendmentDraft(ctx, body);
});
