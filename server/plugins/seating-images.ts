import { logError } from "../utils/core/logger";
import {
  EXPORT_QUEUE_BOOT_ATTEMPTS,
  getExportQueue,
} from "../utils/export/queue";
import { startSeatingImages, stopSeatingImages } from "../utils/seating/images";

/**
 * The images of the seating view (server/utils/seating/images.ts): creates
 * the `seating-images` queue and starts its worker on the pg-boss instance
 * the export worker starts. Without DATABASE_URL there is no pg-boss
 * (export-worker.ts already warns).
 */
export default defineNitroPlugin((nitroApp) => {
  if (!process.env.DATABASE_URL) return;
  // Not awaited: Nitro does not await plugins; problems are logged.
  void getExportQueue({ attempts: EXPORT_QUEUE_BOOT_ATTEMPTS })
    .then((boss) => startSeatingImages(boss))
    .catch((error) => logError("seating.images", error, { action: "start" }));
  nitroApp.hooks.hook("close", () => {
    stopSeatingImages();
  });
});
