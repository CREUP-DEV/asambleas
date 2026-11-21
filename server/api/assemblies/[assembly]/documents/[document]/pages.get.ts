import { defineEventHandler } from "h3";
import { resolveDocumentRoute } from "../../../../../utils/domain/documents";
import { requireViewer } from "../../../../../utils/domain/roomView";
import { loadDocumentPages } from "../../../../../utils/export/documentPages";
import type { DocumentPagesDto } from "~~/shared/types/api";

/**
 * Where the pages of the document's clean PDF start, for the web text
 * (user's decisions of 2026-11-21): whoever reads the document reads them.
 */
export default defineEventHandler(async (event): Promise<DocumentPagesDto> => {
  // First: with `?view=room` the route resolves as the room viewer.
  await requireViewer(event);
  const { assembly, document } = await resolveDocumentRoute(event);
  return loadDocumentPages(assembly, document);
});
