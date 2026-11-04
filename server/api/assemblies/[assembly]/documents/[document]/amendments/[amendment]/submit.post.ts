import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  loadAmendmentContext,
  submitAmendment,
} from "../../../../../../../utils/domain/amendments";

/** Submits a draft: numbers it, computes `late` and opens its position. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  return submitAmendment(ctx);
});
