import { createError, defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetNotesDto } from "~~/shared/types/api";
import { loadVisibleDocuments } from "../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import {
  requireViewer,
  wantsRoomView,
} from "../../../../utils/domain/roomView";
import { loadControlSheetNotes } from "../../../../utils/domain/sheetReaders";

/**
 * «Mis notas» of the control sheet (user's decision of 2026-11-21): the
 * account's own general private notes on the documents and amendments the
 * sheet shows it (loadControlSheetNotes). Whoever opens the sheet reads its
 * own; never as the room.
 */
export default defineEventHandler(
  async (event): Promise<ControlSheetNotesDto> => {
    const actor = await requireViewer(event);
    if (wantsRoomView(event)) {
      throw createError({
        statusCode: 403,
        message: "La hoja de control no se lee como la sala",
      });
    }
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    return loadControlSheetNotes(
      actor,
      await loadVisibleDocuments(actor, assembly.id),
    );
  },
);
