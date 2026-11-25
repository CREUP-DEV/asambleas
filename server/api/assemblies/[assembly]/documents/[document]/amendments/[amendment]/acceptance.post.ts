import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { acceptanceBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentContext,
  recordAmendmentAcceptance,
} from "../../../../../../../utils/domain/amendments";

/** A party of a transactional accepts or rejects it, or the Mesa records its answer. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readBodyWith(event, acceptanceBodySchema, { empty: {} });
  return recordAmendmentAcceptance(ctx, body);
});
