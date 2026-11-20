import { defineEventHandler } from "h3";
import type { BulkLapseDto } from "~~/shared/types/api";
import { bulkAssentBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  applyBulkLapse,
  loadAmendmentDocumentContext,
  readAmendmentBody,
} from "../../../../../../utils/domain/amendments";

/**
 * The Mesa marks several amendments as lapsed in one request (the lapse
 * offer after a decision). The body has the shape of the bloc's assent.
 */
export default defineEventHandler(async (event): Promise<BulkLapseDto> => {
  const ctx = await loadAmendmentDocumentContext(event);
  const body = await readAmendmentBody(event, bulkAssentBodySchema);
  return applyBulkLapse(ctx, body);
});
