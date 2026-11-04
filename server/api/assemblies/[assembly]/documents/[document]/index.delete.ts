import { defineEventHandler } from "h3";
import {
  deleteDocument,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";

export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const ctx = await resolveDocumentRoute(event);
  return deleteDocument(ctx);
});
