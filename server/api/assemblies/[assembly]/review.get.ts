import { createError, defineEventHandler, getRouterParam } from "h3";
import type { ReviewQueueDto } from "~~/shared/types/api";
import { requireActor } from "../../../utils/domain/actor";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import {
  canUseReviewQueue,
  loadReviewQueue,
} from "../../../utils/domain/review";

/** The Secretaría's validation inbox (document:manage or amendment:review). */
export default defineEventHandler(async (event): Promise<ReviewQueueDto> => {
  const actor = await requireActor(event);
  if (!canUseReviewQueue(actor)) {
    throw createError({
      statusCode: 403,
      message: "No tienes permiso para revisar la documentación",
    });
  }
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadReviewQueue(actor, assembly);
});
