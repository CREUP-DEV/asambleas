import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { positionBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentContext,
  readAmendmentBody,
  setAmendmentPosition,
} from "../../../../../../../utils/domain/amendments";

/** Records the document proponent's position on the amendment. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readAmendmentBody(event, positionBodySchema);
  return setAmendmentPosition(ctx, body);
});
