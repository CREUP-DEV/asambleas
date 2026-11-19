import { defineEventHandler } from "h3";
import type { AmendmentDto } from "~~/shared/types/api";
import { transactionalRevisionBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  loadAmendmentContext,
  proposeTransactionalRevision,
  readAmendmentBody,
} from "../../../../../../../../utils/domain/amendments";

/**
 * Proposes including amendments in an existing transactional, with its new
 * text: every party of the new version answers it (user's decision of
 * 2026-11-19).
 */
export default defineEventHandler(async (event): Promise<AmendmentDto> => {
  const ctx = await loadAmendmentContext(event);
  const body = await readAmendmentBody(event, transactionalRevisionBodySchema);
  return proposeTransactionalRevision(ctx, body);
});
