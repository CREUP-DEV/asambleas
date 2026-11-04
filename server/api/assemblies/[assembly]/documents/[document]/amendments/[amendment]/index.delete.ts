import { defineEventHandler } from "h3";
import {
  deleteAmendmentDraft,
  loadAmendmentContext,
} from "../../../../../../../utils/domain/amendments";

/** Deletes a draft amendment. Submitted amendments are withdrawn instead. */
export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const ctx = await loadAmendmentContext(event);
  return deleteAmendmentDraft(ctx);
});
