import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetItemRowDto } from "~~/shared/types/api";
import { controlSheetItemBodySchema } from "~~/shared/utils/schemas/controlSheet";
import { canModerate } from "../../../../../utils/domain/actor";
import {
  requireControlSheetReader,
  resolveSheetItem,
  sheetItemBodyOnlyTreated,
  updateSheetItem,
} from "../../../../../utils/domain/controlSheet";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * Changes what the control sheet notes about an agenda item. A sheet key's,
 * but for the Mesa's treated mark alone, which the Mesa (session:moderate)
 * also sets or undoes from the session console with or without a sheet key
 * (user's decision of 2026-11-19).
 */
export default defineEventHandler(
  async (event): Promise<ControlSheetItemRowDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    const body = await readBodyWith(event, controlSheetItemBodySchema);
    if (!(canModerate(actor) && sheetItemBodyOnlyTreated(body))) {
      requireControlSheetReader(actor);
    }
    const item = await resolveSheetItem(
      actor,
      assembly,
      getRouterParam(event, "item"),
    );
    try {
      return await updateSheetItem(actor, assembly, item, body);
    } catch (error) {
      throwMutationError("controlSheet.item", error, event);
    }
  },
);
