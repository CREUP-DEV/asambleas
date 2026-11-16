import { logError } from "../utils/core/logger";
import {
  EXPORT_QUEUE_BOOT_ATTEMPTS,
  getExportQueue,
} from "../utils/export/queue";
import { startUserAvatars } from "../utils/auth/avatars";
import { seatingErrorSummary } from "../utils/seating/errors";

/**
 * The accounts' photos (server/utils/auth/avatars.ts): creates the
 * `user-avatars` queue, starts its worker on the pg-boss instance the export
 * worker starts and queues, once per boot, the photos not stored yet.
 * Without DATABASE_URL there is no pg-boss (export-worker.ts already warns).
 */
export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return;
  // Not awaited: Nitro does not await plugins; problems are logged.
  void getExportQueue({ attempts: EXPORT_QUEUE_BOOT_ATTEMPTS })
    .then((boss) => startUserAvatars(boss))
    // By name and SQLSTATE only, as every avatar error (avatars.ts).
    .catch((error) =>
      logError("auth.avatars", seatingErrorSummary(error), { action: "start" }),
    );
});
