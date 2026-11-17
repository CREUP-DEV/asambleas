import { subscribeToAll } from "../utils/live/hub";
import {
  onPackageLiveMessage,
  stopPackagePrebuilds,
} from "../utils/export/package/service";

/**
 * Keeps the documentation packages (server/utils/export/package) in step
 * with their assemblies: every committed change that may touch what a
 * package shows drops its cached plan and, after a quiet spell, builds the
 * Spanish packages of a convened or sitting assembly ahead of anyone
 * asking, so the room downloads a ready ZIP. Only the pieces that changed
 * are rendered again.
 */
export default defineNitroPlugin((nitroApp) => {
  if (!process.env.DATABASE_URL) return;
  const unsubscribe = subscribeToAll(onPackageLiveMessage);
  nitroApp.hooks.hook("close", () => {
    unsubscribe();
    stopPackagePrebuilds();
  });
});
