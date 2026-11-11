import { defineEventHandler } from "h3";
import { resolveDocumentRoute } from "../../../../../utils/domain/documents";
import { listDocumentFiles } from "../../../../../utils/domain/documentFiles";
import type { DocumentFileVersionDto } from "~~/shared/types/api";

/** The PDFs a published document replaced; document managers only. */
export default defineEventHandler(
  async (event): Promise<DocumentFileVersionDto[]> =>
    listDocumentFiles(await resolveDocumentRoute(event)),
);
