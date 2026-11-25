import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam, setResponseStatus } from "h3";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { BulkDocumentsDto } from "~~/shared/types/api";
import { bulkDocumentsSchema } from "~~/shared/utils/schemas/document";
import { requireCan } from "../../../../../utils/domain/actor";
import { createDocuments } from "../../../../../utils/domain/documentCreate";
import { resolveAgendaItem } from "../../../../../utils/domain/resolvers";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * Adds several documents to one agenda item in one go (document:manage):
 * all of them or none. Each starts as an empty draft with the defaults of
 * its kind; under an item that accepts submissions each one gets its own
 * automatic sub-item. A row left without `proponentMemberId` has no
 * presenter. The answer lists them in the order sent, so the client can
 * upload a PDF to each `file` document (POST .../documents/[document]/file).
 * A row that breaks a rule answers with `data.index`.
 */
export default defineEventHandler(async (event): Promise<BulkDocumentsDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireCan(actor, PERMISSION_KEYS.DOCUMENT_MANAGE);
  const item = await resolveAgendaItem(
    assembly.id,
    getRouterParam(event, "item"),
  );
  const body = await readBodyWith(event, bulkDocumentsSchema);

  const documents = await createDocuments(
    { actor, assembly, agendaItemId: item.id },
    body.documents.map((row) => ({
      ...row,
      // Unlike a single create, a row never defaults to the manager's own
      // member: the Secretaría adds documents for others.
      proponentMemberId: row.proponentMemberId ?? null,
    })),
  );

  setResponseStatus(event, 201);
  return { documents };
});
