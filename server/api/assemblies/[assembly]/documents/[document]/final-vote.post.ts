import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import {
  recordFinalVote,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { controlsProjection } from "../../../../../utils/domain/projectionControl";
import type { DocumentDto } from "~~/shared/types/api";
import { finalVoteSchema } from "~~/shared/utils/schemas/document";

export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = await readBodyWith(event, finalVoteSchema);
  return recordFinalVote(ctx, body, {
    controlsProjection: controlsProjection(event, ctx.assembly.id, ctx.actor),
  });
});
