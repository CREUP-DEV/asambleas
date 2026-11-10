import {
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "h3";
import { requireActor } from "../../../../utils/domain/actor";
import {
  resolveAgendaItem,
  resolveAssembly,
} from "../../../../utils/domain/resolvers";
import { createDocuments } from "../../../../utils/domain/documentCreate";
import {
  loadDocumentDto,
  parseDocumentBody,
} from "../../../../utils/domain/documents";
import type { DocumentDto } from "~~/shared/types/api";
import { documentCreateSchema } from "~~/shared/utils/schemas/document";

/**
 * Creates one document under an agenda item (createDocuments has the
 * rules). Under an item that accepts submissions the document gets its own
 * automatic sub-item, so the `agendaItemId` of the answer is that
 * sub-item's, not the one sent.
 */
export default defineEventHandler(async (event): Promise<DocumentDto> => {
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const { agendaItemId, ...input } = parseDocumentBody(
    documentCreateSchema,
    await readBody(event),
  );
  const item = await resolveAgendaItem(assembly.id, agendaItemId);

  const [created] = await createDocuments(
    { actor, assembly, agendaItemId: item.id },
    [input],
  );

  setResponseStatus(event, 201);
  return loadDocumentDto(assembly, created!.id, actor);
});
