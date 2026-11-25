import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetDocumentObservationsDto } from "~~/shared/types/api";
import {
  loadDocumentSheetObservations,
  requireControlSheetReader,
} from "../../../../../utils/domain/controlSheet";
import { resolveDocument } from "../../../../../utils/domain/resolvers";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * The control sheet's observations about one document and its amendments,
 * for its page (control_sheet:view or :edit). Never as the room.
 */
export default defineEventHandler(
  async (event): Promise<ControlSheetDocumentObservationsDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event, {
      viewer: true,
    });
    requireControlSheetReader(actor);
    const document = await resolveDocument(
      actor,
      assembly.id,
      getRouterParam(event, "document"),
    );
    return loadDocumentSheetObservations(actor, assembly, document);
  },
);
