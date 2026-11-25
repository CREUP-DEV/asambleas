import { readBodyWith } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam } from "h3";
import type { ControlSheetAmendmentRowDto } from "~~/shared/types/api";
import { controlSheetAmendmentBodySchema } from "~~/shared/utils/schemas/controlSheet";
import {
  requireControlSheetReader,
  resolveSheetAmendment,
  updateSheetAmendment,
} from "../../../../../utils/domain/controlSheet";
import { throwMutationError } from "../../../../../utils/errors";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/** Changes what the control sheet notes about an amendment. */
export default defineEventHandler(
  async (event): Promise<ControlSheetAmendmentRowDto> => {
    const { actor, assembly } = await resolveAssemblyRoute(event);
    requireControlSheetReader(actor);
    const amendment = await resolveSheetAmendment(
      actor,
      assembly,
      getRouterParam(event, "amendment"),
    );
    const body = await readBodyWith(event, controlSheetAmendmentBodySchema);
    try {
      return await updateSheetAmendment(actor, assembly, amendment, body);
    } catch (error) {
      throwMutationError("controlSheet.amendment", error, event);
    }
  },
);
