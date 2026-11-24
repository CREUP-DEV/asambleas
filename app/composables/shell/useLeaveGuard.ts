import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import { routeUpdateLeavesPage } from "./leaveGuard";

/**
 * Asks before a screen with unsaved work goes away: leaving the page,
 * going to another document (the same page with other params, which Nuxt
 * mounts again), "atrás", and reloading or closing the tab. A change of the
 * query alone never asks (`routeUpdateLeavesPage`).
 *
 * Every screen with unsaved work uses it, composers and forms alike, never
 * its own guards (AGENTS.md). The one exception is the control sheet's
 * `RowPanel`, which saves before it asks.
 *
 * `hasWork` says whether something would be lost; `question` is the
 * screen's own wording of the question. `confirmLeaving` asks the same
 * question for a leave the page makes by itself (`sala.vue`).
 */
export function useLeaveGuard(
  hasWork: () => boolean,
  question: () => string,
): { confirmLeaving: () => boolean } {
  function confirmLeaving(): boolean {
    if (!hasWork()) return true;
    return window.confirm(question());
  }

  onBeforeRouteLeave(confirmLeaving);
  onBeforeRouteUpdate((to, from) =>
    routeUpdateLeavesPage(to, from) ? confirmLeaving() : true,
  );

  // Reloading or closing the tab: the browser asks, in its own words.
  useEventListener("beforeunload", (event: BeforeUnloadEvent) => {
    if (!hasWork()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  return { confirmLeaving };
}
