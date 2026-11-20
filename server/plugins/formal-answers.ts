import { logError } from "../utils/core/logger";
import { backfillFormalAnswers } from "../utils/domain/formalBackfill";

/**
 * Once per boot, the formal amendments validated before today's rules are
 * published, accepted by themselves and incorporated as those rules would
 * have done (backfillFormalAnswers): after the first boot of the release
 * that brought them, nothing is left to do.
 */
export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return;
  // Not awaited: Nitro does not await plugins; problems are logged.
  void backfillFormalAnswers().catch((error) =>
    logError("amendments.formal_backfill", error),
  );
});
