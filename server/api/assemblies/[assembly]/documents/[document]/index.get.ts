import { defineEventHandler } from "h3";
import {
  loadDocumentDto,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";

export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const { actor, assembly, document } = await resolveDocumentRoute(event);
  return loadDocumentDto(assembly, document.id, actor);
});
