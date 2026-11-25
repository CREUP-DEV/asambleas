import { defineEventHandler } from "h3";
import type { ControlSheetDto } from "~~/shared/types/api";
import { loadControlSheet } from "../../../../utils/domain/controlSheet";
import { refuseRoomView } from "../../../../utils/domain/roomView";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/**
 * The control sheet of an assembly, to whoever sees the assembly: all of it
 * with a sheet key, its public part to everyone else (loadControlSheet). It
 * never answers as the room: `?view=room` is refused, since the room reads
 * no sheet.
 */
export default defineEventHandler(async (event): Promise<ControlSheetDto> => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  refuseRoomView(event, "La hoja de control no se lee como la sala");
  return loadControlSheet(actor, assembly);
});
