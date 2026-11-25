import { defineEventHandler } from "h3";
import type { ControlSheetNotesDto } from "~~/shared/types/api";
import { loadVisibleDocuments } from "../../../../utils/domain/controlSheet";
import { refuseRoomView } from "../../../../utils/domain/roomView";
import { loadControlSheetNotes } from "../../../../utils/domain/sheetReaders";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * «Mis notas» of the control sheet (user's decision of 2026-11-21): the
 * account's own general private notes on the documents and amendments the
 * sheet shows it (loadControlSheetNotes). Whoever opens the sheet reads its
 * own; never as the room.
 */
export default defineEventHandler(
  async (event): Promise<ControlSheetNotesDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event, {
      viewer: true,
    });
    refuseRoomView(event, "La hoja de control no se lee como la sala");
    return loadControlSheetNotes(
      actor,
      await loadVisibleDocuments(actor, assembly.id),
    );
  },
);
