import { defineEventHandler } from "h3";
import type { EventDto } from "~~/shared/types/api";
import {
  amendmentHistory,
  loadAmendmentContext,
} from "../../../../../../../utils/domain/amendments";

/** The amendment's event history, oldest first. */
export default defineEventHandler(async (event): Promise<EventDto[]> => {
  const ctx = await loadAmendmentContext(event);
  return amendmentHistory(ctx);
});
