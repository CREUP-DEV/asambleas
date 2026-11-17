import { logError } from "../utils/core/logger";
import { backfillFormalAnswers } from "../utils/domain/formalBackfill";

/**
 * Once per boot, the automatic acceptance of the formal amendments that
 * could be answered before it existed (backfillFormalAnswers): after the
 * first boot of the release that brought it, nothing is left to do.
 */
export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return;
  // Not awaited: Nitro does not await plugins; problems are logged.
  void backfillFormalAnswers().catch((error) =>
    logError("amendments.formal_backfill", error),
  );
});
