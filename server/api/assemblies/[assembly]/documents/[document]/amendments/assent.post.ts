import { defineEventHandler } from "h3";
import type { BulkAssentDto } from "~~/shared/types/api";
import { bulkAssentBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  applyBulkAssent,
  loadAmendmentDocumentContext,
  readAmendmentBody,
} from "../../../../../../utils/domain/amendments";

/** The Mesa approves a bloc of amendments by assent, in one request. */
export default defineEventHandler(async (event): Promise<BulkAssentDto> => {
  const ctx = await loadAmendmentDocumentContext(event);
  const body = await readAmendmentBody(event, bulkAssentBodySchema);
  return applyBulkAssent(ctx, body);
});
