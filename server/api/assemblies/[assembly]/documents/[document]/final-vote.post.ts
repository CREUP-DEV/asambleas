import { defineEventHandler, readBody } from "h3";
import {
  parseDocumentBody,
  recordFinalVote,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { controlsProjection } from "../../../../../utils/domain/projectionControl";
import type { DocumentDto } from "~~/shared/types/api";
import { finalVoteSchema } from "~~/shared/utils/schemas/document";

export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = parseDocumentBody(finalVoteSchema, await readBody(event));
  return recordFinalVote(ctx, body, {
    controlsProjection: controlsProjection(event, ctx.assembly.id, ctx.actor),
  });
});
