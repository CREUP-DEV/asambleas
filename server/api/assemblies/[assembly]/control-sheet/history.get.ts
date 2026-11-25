import { readQueryWith } from "../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetHistoryDto } from "~~/shared/types/api";
import { controlSheetHistoryQuerySchema } from "~~/shared/utils/schemas/controlSheet";
import {
  loadSheetHistory,
  requireControlSheetReader,
} from "../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../utils/domain/resolvers";
import { requireViewer } from "../../../../utils/domain/roomView";

/** The history of one row of the control sheet (who changed what, when). */
export default defineEventHandler(
  async (event): Promise<ControlSheetHistoryDto> => {
    const actor = await requireViewer(event);
    requireControlSheetReader(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const { row } = readQueryWith(event, controlSheetHistoryQuerySchema);
    return loadSheetHistory(actor, assembly, row);
  },
);
