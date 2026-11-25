import { logError } from "../utils/core/logger";
import { onExportQueueStart } from "../utils/export/queue";
import { startUserAvatars } from "../utils/auth/avatars";
import { errorSummary } from "../utils/errors";

/**
 * The accounts' photos (server/utils/auth/avatars.ts): creates the
 * `user-avatars` queue, starts its worker on the export queue's pg-boss
 * instance and queues, once per boot, the photos not stored yet. Registered
 * through the instance's shared start (onExportQueueStart), so the worker
 * comes up whoever starts it: the export worker's boot start, or a request
 * after that one gave up. Without DATABASE_URL there is no pg-boss
 * (export-worker.ts already warns).
 */
export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return;
  onExportQueueStart("user-avatars", async (boss) => {
    try {
      await startUserAvatars(boss);
    } catch (error) {
      // By name and SQLSTATE only, as every avatar error (avatars.ts).
      logError("auth.avatars", errorSummary(error), { action: "start" });
    }
  });
});
