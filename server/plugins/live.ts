import { logWarn } from "../utils/core/logger";
import { startLiveHub, stopLiveHub } from "../utils/live/hub";

export default defineNitroPlugin(async (nitroApp) => {
  if (!process.env.DATABASE_URL) {
    logWarn("live.init", {
      reason: "DATABASE_URL not set, live updates disabled",
    });
    return;
  }
  await startLiveHub();
  nitroApp.hooks.hook("close", async () => {
    await stopLiveHub();
  });
});
