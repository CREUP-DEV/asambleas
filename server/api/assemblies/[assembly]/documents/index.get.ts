import { defineEventHandler, getRouterParam } from "h3";
import { requireActor } from "../../../../utils/domain/actor";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { loadDocumentSummaries } from "../../../../utils/domain/documents";
import type { DocumentSummaryDto } from "~~/shared/types/api";

export default defineEventHandler(async (event): Promise<DocumentSummaryDto[]> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(actor, getRouterParam(event, "assembly"));
  return loadDocumentSummaries(assembly, actor);
});
