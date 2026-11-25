import { readBodyWith } from "../../../../../../utils/core/http";
import { defineEventHandler } from "h3";
import { admissionBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  decideAmendmentAdmission,
  loadAmendmentDocumentContext,
  type AmendmentAdmissionResult,
} from "../../../../../../utils/domain/amendments";
import { controlsProjection } from "../../../../../../utils/domain/projectionControl";

/**
 * Admits or declares inadmissible one or more amendments, recording the
 * decision; an admission vote goes on screen only from the console that
 * controls the projection.
 */
export default defineEventHandler(
  async (event): Promise<AmendmentAdmissionResult> => {
    const ctx = await loadAmendmentDocumentContext(event);
    const body = await readBodyWith(event, admissionBodySchema, { empty: {} });
    return decideAmendmentAdmission(ctx, body, {
      controlsProjection: controlsProjection(event, ctx.assembly.id, ctx.actor),
    });
  },
);
