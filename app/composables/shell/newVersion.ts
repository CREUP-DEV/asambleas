import type { NuxtApp } from "#app";

/** `/_nuxt/builds/latest.json` under the app's base and assets dir. */
function latestBuildUrl(app: {
  baseURL: string;
  cdnURL?: string;
  buildAssetsDir: string;
}): string {
  const parts = [
    app.cdnURL || app.baseURL,
    app.buildAssetsDir,
    "builds/latest.json",
  ]
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const url = parts.join("/");
  return /^https?:/.test(url) ? url : `/${url}`;
}

/**
 * A new version of the platform was deployed while the page was open
 * (user's decision of 2026-11-19). Nuxt checks its own build id against
 * `/_nuxt/builds/latest.json` every `experimental.checkOutdatedBuildInterval`
 * and calls the `app:manifest:update` hook, which the plugin
 * `new-version.client.ts` turns into a notice (or a reload, on the
 * projection). This check does the same at once: the live stream calls it
 * when it reconnects after missing changes, which is what a deploy does to
 * every open assembly page (the app restarts and the stream drops).
 */
export async function checkForNewVersion(nuxtApp: NuxtApp): Promise<void> {
  const app = nuxtApp.$config.app;
  try {
    const latest = await $fetch<{ id?: string }>(latestBuildUrl(app), {
      query: { t: Date.now() },
    });
    if (latest?.id && latest.id !== app.buildId) {
      await nuxtApp.hooks.callHook("app:manifest:update", {
        id: latest.id,
        timestamp: Date.now(),
      });
    }
  } catch {
    // No manifest (development) or the server is restarting: Nuxt's own
    // check comes again within a minute.
  }
}

/** The projection: shown to the room, so it reloads instead of asking. */
export function isProjectionPath(path: string): boolean {
  return /(^|\/)proyeccion(\/|$)/.test(path);
}
