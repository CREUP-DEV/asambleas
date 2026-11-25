import { readBodyWith } from "../../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { positionBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentContext,
  setAmendmentPosition,
} from "../../../../../../../utils/domain/amendments";

/** Records the document proponent's position on the amendment. */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readBodyWith(event, positionBodySchema, { empty: {} });
  return setAmendmentPosition(ctx, body);
});
