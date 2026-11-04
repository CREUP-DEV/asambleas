import { defineEventHandler, readBody } from "h3";
import {
  annulFinalVote,
  parseDocumentBody,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";
import { finalVoteAnnulSchema } from "~~/shared/utils/schemas/document";

/** Annuls a wrongly recorded final vote. Body: FinalVoteAnnulBody. */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const ctx = await resolveDocumentRoute(event);
  const body = parseDocumentBody(
    finalVoteAnnulSchema,
    (await readBody(event)) ?? {},
  );
  return annulFinalVote(ctx, body);
});
