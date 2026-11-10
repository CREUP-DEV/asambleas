import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { reclassifyBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentContext,
  readAmendmentBody,
  reclassifyAmendment,
} from "../../../../../../../utils/domain/amendments";

/**
 * The Secretaría moves a presented, undecided amendment between "de forma"
 * and the content kind. Requires the `updatedAt` the client last saw.
 */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readAmendmentBody(event, reclassifyBodySchema);
  return reclassifyAmendment(ctx, body);
});
