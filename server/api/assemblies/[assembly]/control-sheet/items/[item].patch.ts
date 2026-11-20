import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetItemRowDto } from "~~/shared/types/api";
import { controlSheetItemBodySchema } from "~~/shared/utils/schemas/controlSheet";
import { canModerate, requireActor } from "../../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../../utils/domain/assemblies";
import {
  requireControlSheetReader,
  resolveSheetItem,
  sheetItemBodyOnlyTreated,
  updateSheetItem,
} from "../../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../../utils/errors";

/**
 * Changes what the control sheet notes about an agenda item. A sheet key's,
 * but for the Mesa's treated mark alone, which the Mesa (session:moderate)
 * also sets or undoes from the session console with or without a sheet key
 * (user's decision of 2026-11-19).
 */
export default defineEventHandler(
  async (event): Promise<ControlSheetItemRowDto> => {
    const actor = await requireActor(event);
    const body = await readAssemblyBody(event, controlSheetItemBodySchema);
    if (!(canModerate(actor) && sheetItemBodyOnlyTreated(body))) {
      requireControlSheetReader(actor);
    }
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
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
