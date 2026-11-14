import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetDto } from "~~/shared/types/api";
import {
  loadControlSheet,
  requireControlSheetReader,
} from "../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { requireViewer } from "../../../../utils/domain/roomView";

/**
 * The control sheet of an assembly (control_sheet:view or :edit). It never
 * answers as the room: `?view=room` is refused, since the room reads no
 * sheet.
 */
export default defineEventHandler(async (event): Promise<ControlSheetDto> => {
  const actor = await requireViewer(event);
  requireControlSheetReader(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  return loadControlSheet(actor, assembly);
});
