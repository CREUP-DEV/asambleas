import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { amendmentUpdateBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentContext,
  updateAmendmentDraft,
} from "../../../../../../../utils/domain/amendments";

/** Edits a draft amendment. Requires the `updatedAt` the client last saw. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readBodyWith(event, amendmentUpdateBodySchema, {
    empty: {},
  });
  return updateAmendmentDraft(ctx, body);
});
