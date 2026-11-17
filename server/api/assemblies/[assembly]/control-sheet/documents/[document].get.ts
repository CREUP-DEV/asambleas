import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetDocumentObservationsDto } from "~~/shared/types/api";
import {
  loadDocumentSheetObservations,
  requireControlSheetReader,
} from "../../../../../utils/domain/controlSheet";
import {
  resolveAssembly,
  resolveDocument,
} from "../../../../../utils/domain/resolvers";
import { requireViewer } from "../../../../../utils/domain/roomView";

/**
 * The control sheet's observations about one document and its amendments,
 * for its page (control_sheet:view or :edit). Never as the room.
 */
export default defineEventHandler(
  async (event): Promise<ControlSheetDocumentObservationsDto> => {
    const actor = await requireViewer(event);
    requireControlSheetReader(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const document = await resolveDocument(
      actor,
      assembly.id,
      getRouterParam(event, "document"),
    );
    return loadDocumentSheetObservations(actor, assembly, document);
  },
);
