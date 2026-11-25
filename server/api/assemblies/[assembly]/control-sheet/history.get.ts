import { readQueryWith } from "../../../../utils/core/http";
import { defineEventHandler } from "h3";
import type { ControlSheetHistoryDto } from "~~/shared/types/api";
import { controlSheetHistoryQuerySchema } from "~~/shared/utils/schemas/controlSheet";
import {
  loadSheetHistory,
  requireControlSheetReader,
} from "../../../../utils/domain/controlSheet";
import { resolveAssemblyRoute } from "../../../../utils/domain/assemblyRoute";

/** The history of one row of the control sheet (who changed what, when). */
export default defineEventHandler(
  async (event): Promise<ControlSheetHistoryDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event, {
      viewer: true,
    });
    requireControlSheetReader(actor);
    const { row } = readQueryWith(event, controlSheetHistoryQuerySchema);
    return loadSheetHistory(actor, assembly, row);
  },
);
