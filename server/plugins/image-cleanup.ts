import { logError } from "../utils/core/logger";
import { setupImageCleanupSchedule } from "../utils/domain/imageCleanup";
import { getExportQueue } from "../utils/export/queue";

/**
 * The daily clean-up of document images nothing uses
 * (server/utils/domain/imageCleanup.ts), on the pg-boss instance the export
 * worker starts. Without DATABASE_URL there is no pg-boss (export-worker.ts
 * already warns).
 */
export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return;
  // Not awaited: Nitro does not await plugins; problems are logged.
  void getExportQueue({ attempts: 5 })
    .then((boss) => setupImageCleanupSchedule(boss))
    .catch((error) => logError("imageCleanup.schedule", error));
});
