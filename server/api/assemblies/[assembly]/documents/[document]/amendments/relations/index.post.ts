import { defineEventHandler, setResponseStatus } from "h3";
import type { RelationDto } from "~~/shared/types/api";
import { relationBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  createAmendmentRelation,
  loadAmendmentDocumentContext,
  readAmendmentBody,
} from "../../../../../../../utils/domain/amendments";

/** Links two amendments of the document (incompatible, duplicate...). */
export default defineEventHandler(async (event): Promise<RelationDto> => {
  const ctx = await loadAmendmentDocumentContext(event);
  const body = await readAmendmentBody(event, relationBodySchema);
  const relation = await createAmendmentRelation(ctx, body);
  setResponseStatus(event, 201);
  return relation;
});
