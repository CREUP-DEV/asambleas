import { logWarn } from "../utils/core/logger";
import {
  startNotifications,
  stopNotifications,
} from "../utils/notifications/runner";

/**
 * The email notifications (server/utils/notifications/runner.ts): sends
 * what the outbox queues and the daily summaries. Without DATABASE_URL
 * there is nothing to read.
 */
export default defineNitroPlugin((nitroApp) => {
  if (!process.env.DATABASE_URL) {
    logWarn("email.runner", { reason: "DATABASE_URL not set" });
    return;
  }
  // Not awaited: Nitro does not await plugins, and the start logs its own
  // problems instead of throwing.
  void startNotifications();
  nitroApp.hooks.hook("close", async () => {
    await stopNotifications();
  });
});
