import { defineEventHandler, getRouterParam } from "h3";
import {
  deleteAmendmentRelation,
  loadAmendmentDocumentContext,
} from "../../../../../../../utils/domain/amendments";

/** Removes a relation between two amendments of the document. */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const ctx = await loadAmendmentDocumentContext(event);
  return deleteAmendmentRelation(ctx, getRouterParam(event, "relation"));
});
