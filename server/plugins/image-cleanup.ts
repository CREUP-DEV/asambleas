import { setupImageCleanupSchedule } from "../utils/domain/imageCleanup";
import { onExportQueueStart } from "../utils/export/queue";

/**
 * The daily clean-up of document images nothing uses
 * (server/utils/domain/imageCleanup.ts), on the export queue's pg-boss
 * instance, registered through its shared start (onExportQueueStart): it
 * comes up with the instance whoever starts it, and a starter that fails is
 * logged there. Without DATABASE_URL there is no pg-boss (export-worker.ts
 * already warns).
 */
export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return;
  onExportQueueStart("image-cleanup", setupImageCleanupSchedule);
});
