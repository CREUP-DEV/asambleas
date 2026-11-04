import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  loadAmendmentContext,
  withdrawAmendment,
} from "../../../../../../../utils/domain/amendments";

/** Withdraws a submitted, undecided amendment (its authors or the Mesa). */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  return withdrawAmendment(ctx);
});
