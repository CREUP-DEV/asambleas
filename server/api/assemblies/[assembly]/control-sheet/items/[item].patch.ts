import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetItemRowDto } from "~~/shared/types/api";
import { controlSheetItemBodySchema } from "~~/shared/utils/schemas/controlSheet";
import { requireActor } from "../../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../../utils/domain/assemblies";
import {
  requireControlSheetReader,
  resolveSheetItem,
  updateSheetItem,
} from "../../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../../utils/errors";

/** Changes what the control sheet notes about an agenda item. */
export default defineEventHandler(
  async (event): Promise<ControlSheetItemRowDto> => {
    const actor = await requireActor(event);
    requireControlSheetReader(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const item = await resolveSheetItem(
      actor,
      assembly,
      getRouterParam(event, "item"),
    );
    const body = await readAssemblyBody(event, controlSheetItemBodySchema);
    try {
      return await updateSheetItem(actor, assembly, item, body);
    } catch (error) {
      throwMutationError("controlSheet.item", error, event);
    }
  },
);
