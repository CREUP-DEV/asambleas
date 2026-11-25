import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler, setResponseStatus } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { amendmentDraftBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  createAmendmentDraft,
  loadAmendmentDocumentContext,
} from "../../../../../../utils/domain/amendments";

/** Creates a draft amendment anchored to the document's base version. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentDocumentContext(event);
  const body = await readBodyWith(event, amendmentDraftBodySchema, {
    empty: {},
  });
  const amendment = await createAmendmentDraft(ctx, body);
  setResponseStatus(event, 201);
  return amendment;
});
