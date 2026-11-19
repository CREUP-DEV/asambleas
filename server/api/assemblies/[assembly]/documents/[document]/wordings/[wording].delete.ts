import { defineEventHandler, getRouterParam } from "h3";
import { loadAmendmentDocumentContext } from "../../../../../../utils/domain/amendments";
import { removePassageWording } from "../../../../../../utils/domain/wordings";

/** Removes the Mesa's wording of a passage: the automatic proposal applies again. */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const ctx = await loadAmendmentDocumentContext(event);
  return removePassageWording(ctx, getRouterParam(event, "wording"));
});
