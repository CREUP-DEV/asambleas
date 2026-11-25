import { defineEventHandler } from "h3";
import { loadDocumentSummaries } from "../../../../utils/domain/documents";
import type { DocumentSummaryDto } from "~~/shared/types/api";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

export default defineEventHandler(
  async (event): Promise<DocumentSummaryDto[]> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    return loadDocumentSummaries(assembly, actor);
  },
);
