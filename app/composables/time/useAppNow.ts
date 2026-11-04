import type { Ref } from "vue";

/**
 * One shared clock for everything that depends on "now": countdowns,
 * deadlines that close a button, the next milestone, the greeting.
 *
 * - The server render and the hydration render use the same instant (the
 *   server's render time, carried in the payload), so their text matches.
 * - Once the app is hydrated the client switches to its own clock and ticks
 *   right after every minute boundary, with a single timer for the whole
 *   tab. It also catches up when the tab becomes visible again.
 * - A component created later (client-side navigation) freshens a clock
 *   that is more than a second behind, so it never starts from a stale time.
 *
 * Returns epoch milliseconds. Named apart from VueUse's `useNow`, which is
 * auto-imported too.
 */

const APP_NOW_STATE_KEY = "app-now";
/** Lands each tick just after the minute changes. */
const TICK_MARGIN_MS = 50;
/** How far behind the clock may be when a new consumer appears. */
const FRESHEN_AFTER_MS = 1_000;

/** Milliseconds from `now` until just after the next minute boundary. */
export function msUntilNextMinute(now: number): number {
  return 60_000 - (now % 60_000) + TICK_MARGIN_MS;
}

/** Client only: whether the shared timer is already running in this tab. */
let clockStarted = false;

export function useAppNow(): Readonly<Ref<number>> {
  const now = useState<number>(APP_NOW_STATE_KEY, () => Date.now());

  if (import.meta.client) {
    const nuxtApp = useNuxtApp();
    if (!clockStarted) {
      clockStarted = true;
      const tick = (): void => {
        now.value = Date.now();
        setTimeout(tick, msUntilNextMinute(now.value));
      };
      const start = (): void => {
        tick();
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") now.value = Date.now();
        });
      };
      // Changing it before hydration ends would make the client render
      // differ from the server's.
      if (nuxtApp.isHydrating) onNuxtReady(start);
      else start();
    } else if (
      !nuxtApp.isHydrating &&
      Date.now() - now.value >= FRESHEN_AFTER_MS
    ) {
      now.value = Date.now();
    }
  }

  return readonly(now);
}
