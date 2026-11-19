import { createError, defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetDto } from "~~/shared/types/api";
import { loadControlSheet } from "../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import {
  requireViewer,
  wantsRoomView,
} from "../../../../utils/domain/roomView";

/**
 * The control sheet of an assembly, to whoever sees the assembly: all of it
 * with a sheet key, its public part to everyone else (loadControlSheet). It
 * never answers as the room: `?view=room` is refused, since the room reads
 * no sheet.
 */
export default defineEventHandler(async (event): Promise<ControlSheetDto> => {
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
  return loadControlSheet(actor, assembly);
});
