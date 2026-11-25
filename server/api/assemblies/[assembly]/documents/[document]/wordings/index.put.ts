import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { PassageWordingDto } from "~~/shared/types/api";
import { passageWordingBodySchema } from "~~/shared/utils/schemas/amendment";
import { loadAmendmentDocumentContext } from "../../../../../../utils/domain/amendments";
import { setPassageWording } from "../../../../../../utils/domain/wordings";

/** Sets the Mesa's wording of a passage where approved amendments collide. */
export default defineEventHandler(async (event): Promise<PassageWordingDto> => {
  const ctx = await loadAmendmentDocumentContext(event);
  const body = await readBodyWith(event, passageWordingBodySchema, {
    empty: {},
  });
  return setPassageWording(ctx, body);
});
