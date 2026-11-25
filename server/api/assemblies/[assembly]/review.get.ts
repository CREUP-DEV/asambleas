import { defineEventHandler } from "h3";
import type { ReviewQueueDto } from "~~/shared/types/api";
import {
  loadReviewQueue,
  requireReviewQueue,
} from "../../../utils/domain/review";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/** The Secretaría's validation inbox (document:manage or amendment:review). */
export default defineEventHandler(async (event): Promise<ReviewQueueDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireReviewQueue(actor);
  return loadReviewQueue(actor, assembly);
});
