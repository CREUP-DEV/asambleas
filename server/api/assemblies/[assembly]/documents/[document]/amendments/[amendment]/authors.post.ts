import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { amendmentAuthorsBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  changeAmendmentAuthors,
  loadAmendmentContext,
  readAmendmentBody,
} from "../../../../../../../utils/domain/amendments";

/**
 * The Secretaría corrects who presents a presented, undecided amendment or
 * transactional (its authors and its main author). Requires the
 * `updatedAt` the client last saw.
 */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readAmendmentBody(event, amendmentAuthorsBodySchema);
  return changeAmendmentAuthors(ctx, body);
});
