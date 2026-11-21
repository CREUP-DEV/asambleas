import { logError } from "../utils/core/logger";
import { backfillProposedTransactionals } from "../utils/domain/proposedBackfill";

/**
 * Once per boot, the transactionals a presenter of their document presented
 * before that counted as her answer get it (backfillProposedTransactionals):
 * after the first boot of the release that brought the rule, nothing is
 * left to do.
 */
export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return;
  // Not awaited: Nitro does not await plugins; problems are logged.
  void backfillProposedTransactionals().catch((error) =>
    logError("amendments.proposed_backfill", error),
  );
});
