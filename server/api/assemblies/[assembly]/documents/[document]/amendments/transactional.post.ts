import { defineEventHandler, setResponseStatus } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { transactionalBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  createTransactionalAmendment,
  loadAmendmentDocumentContext,
  readAmendmentBody,
} from "../../../../../../utils/domain/amendments";

/** Creates a transactional amendment over one or more admitted, undecided ones. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentDocumentContext(event);
  const body = await readAmendmentBody(event, transactionalBodySchema);
  const amendment = await createTransactionalAmendment(ctx, body);
  setResponseStatus(event, 201);
  return amendment;
});
