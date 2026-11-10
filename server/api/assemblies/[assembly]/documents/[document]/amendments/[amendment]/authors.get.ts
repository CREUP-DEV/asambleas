import { defineEventHandler } from "h3";
import type { AmendmentComposerAuthorsDto } from "~~/shared/types/api";
import {
  amendmentComposerAuthors,
  loadAmendmentContext,
} from "../../../../../../../utils/domain/amendments";

/**
 * The real authors of a draft, for its composer only: whoever may edit the
 * draft sees which executive offices are among them (everywhere else they
 * read as the generic "CEA"). Members only, never who acted for them.
 */
export default defineEventHandler(
  async (event): Promise<AmendmentComposerAuthorsDto> => {
    const ctx = await loadAmendmentContext(event);
    return amendmentComposerAuthors(ctx);
  },
);
