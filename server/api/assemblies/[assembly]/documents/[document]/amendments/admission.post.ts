import { defineEventHandler } from "h3";
import { admissionBodySchema } from "~~/shared/utils/schemas/amendment";
import {
  decideAmendmentAdmission,
  loadAmendmentDocumentContext,
  readAmendmentBody,
  type AmendmentAdmissionResult,
} from "../../../../../../utils/domain/amendments";

/** Admits or declares inadmissible one or more amendments, recording the decision. */
export default defineEventHandler(
  async (event): Promise<AmendmentAdmissionResult> => {
    const ctx = await loadAmendmentDocumentContext(event);
    const body = await readAmendmentBody(event, admissionBodySchema);
    return decideAmendmentAdmission(ctx, body);
  },
);
