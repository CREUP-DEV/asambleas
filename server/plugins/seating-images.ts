import { onExportQueueStart } from "../utils/export/queue";
import { startSeatingImages, stopSeatingImages } from "../utils/seating/images";

/**
 * The images of the seating view (server/utils/seating/images.ts): creates
 * the `seating-images` queue and starts its worker on the export queue's
 * pg-boss instance, registered through its shared start
 * (onExportQueueStart), so the worker comes up with the instance whoever
 * starts it: the export worker's boot start, or a request after that one
 * gave up. A starter that fails is logged there. Without DATABASE_URL there
 * is no pg-boss (export-worker.ts already warns).
 */
export default defineNitroPlugin((nitroApp) => {
  if (!process.env.DATABASE_URL) return;
  onExportQueueStart("seating-images", startSeatingImages);
  nitroApp.hooks.hook("close", () => {
    stopSeatingImages();
  });
});
