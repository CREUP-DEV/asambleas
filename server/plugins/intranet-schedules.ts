import {
  startIntranetSchedules,
  stopIntranetSchedules,
} from "../utils/members/schedule";

/**
 * The daily intranet jobs (server/utils/members/schedule.ts): on boot it
 * creates their pg-boss queues and schedules
 * - the roster sync at 05:00 Madrid time, when NUXT_INTRANET_API_URL is
 *   configured and NUXT_INTRANET_ROSTER_SYNC is not "false";
 * - the access re-check at 05:30, when an authenticated role lookup is
 *   configured (accounts the Intranet deleted lose access).
 * Without DATABASE_URL there is no pg-boss (export-worker.ts already warns).
 */
export default defineNitroPlugin((nitroApp) => {
  if (!process.env.DATABASE_URL) return;

  // Not awaited: Nitro does not await plugins, and the start logs its own
  // problems instead of throwing.
  void startIntranetSchedules();

  nitroApp.hooks.hook("close", async () => {
    await stopIntranetSchedules();
  });
});
