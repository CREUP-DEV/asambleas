import { onBeforeRouteLeave, onBeforeRouteUpdate } from "vue-router";
import { composerRouteUpdateLeaves } from "./composerLeave";

/**
 * Asks before a composer with work in it goes away: leaving the page,
 * going to another document (the same page with other params, which Nuxt
 * mounts again), "atrás", and reloading or closing the tab. A change of the
 * query alone never asks (`composerRouteUpdateLeaves`).
 *
 * `hasWork` says whether something typed would be lost; `question` is the
 * composer's own wording of the question.
 */
export function useComposerLeaveGuard(
  hasWork: () => boolean,
  question: () => string,
): { confirmLeaving: () => boolean } {
  function confirmLeaving(): boolean {
    if (!hasWork()) return true;
    return window.confirm(question());
  }

  onBeforeRouteLeave(confirmLeaving);
  onBeforeRouteUpdate((to, from) =>
    composerRouteUpdateLeaves(to, from) ? confirmLeaving() : true,
  );

  // Reloading or closing the tab: the browser asks, in its own words.
  useEventListener("beforeunload", (event: BeforeUnloadEvent) => {
    if (!hasWork()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  return { confirmLeaving };
}
