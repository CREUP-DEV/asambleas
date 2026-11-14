import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetAmendmentRowDto } from "~~/shared/types/api";
import { controlSheetAmendmentBodySchema } from "~~/shared/utils/schemas/controlSheet";
import { requireActor } from "../../../../../utils/domain/actor";
import { readAssemblyBody } from "../../../../../utils/domain/assemblies";
import {
  requireControlSheetReader,
  resolveSheetAmendment,
  updateSheetAmendment,
} from "../../../../../utils/domain/controlSheet";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { throwMutationError } from "../../../../../utils/errors";

/** Changes what the control sheet notes about an amendment. */
export default defineEventHandler(
  async (event): Promise<ControlSheetAmendmentRowDto> => {
    const actor = await requireActor(event);
    requireControlSheetReader(actor);
    const assembly = await resolveAssembly(
      actor,
      getRouterParam(event, "assembly"),
    );
    const amendment = await resolveSheetAmendment(
      actor,
      assembly,
      getRouterParam(event, "amendment"),
    );
    const body = await readAssemblyBody(event, controlSheetAmendmentBodySchema);
    try {
      return await updateSheetAmendment(actor, assembly, amendment, body);
    } catch (error) {
      throwMutationError("controlSheet.amendment", error, event);
    }
  },
);
