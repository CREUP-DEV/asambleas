import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { amendmentAuthorsBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  changeAmendmentAuthors,
  loadAmendmentContext,
} from "../../../../../../../utils/domain/amendments";

/**
 * The Secretaría corrects who presents a presented, undecided amendment or
 * transactional (its authors and its main author). Requires the
 * `updatedAt` the client last saw.
 */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readBodyWith(event, amendmentAuthorsBodySchema, {
    empty: {},
  });
  return changeAmendmentAuthors(ctx, body);
});
