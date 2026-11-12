import { defineEventHandler } from "h3";
import {
  loadDocumentDto,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { requireViewer } from "../../../../../utils/domain/roomView";
import type { DocumentDto } from "~~/shared/types/api";

export default defineEventHandler(async (event): Promise<DocumentDto> => {
  // First: with `?view=room` the route resolves as the room viewer.
  await requireViewer(event);
  const { actor, assembly, document } = await resolveDocumentRoute(event);
  return loadDocumentDto(assembly, document.id, actor);
});
