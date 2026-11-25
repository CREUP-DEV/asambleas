import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { BulkAssentDto } from "~~/shared/types/api";
import { bulkAssentBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  applyBulkAssent,
  loadAmendmentDocumentContext,
} from "../../../../../../utils/domain/amendments";

/** The Mesa approves a bloc of amendments by assent, in one request. */
export default defineEventHandler(async (event): Promise<BulkAssentDto> => {
  const ctx = await loadAmendmentDocumentContext(event);
  const body = await readBodyWith(event, bulkAssentBodySchema, { empty: {} });
  return applyBulkAssent(ctx, body);
});
