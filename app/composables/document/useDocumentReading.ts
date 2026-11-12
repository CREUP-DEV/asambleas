import type { MaybeRefOrGetter } from "vue";
import {
  READING_BEAT_MAX_SECONDS,
  READING_BEAT_MS,
  READING_IDLE_MS,
} from "~~/shared/utils/documentViews";
import { errorStatus, isIdentityChanged, useApi } from "../api/useApi";

/** How often the page checks whether someone is at it. */
const TICK_MS = 5_000;

/** Statuses after which the page stops reporting for this document. */
const FINAL_STATUSES = new Set([401, 403, 404]);

/** What counts as someone at the page. */
const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/**
 * Reports how long a published document is open, for the statistics
 * (POST .../documents/[document]/reading, docs/design.md "Statistics"):
 * one view when it opens, then every READING_BEAT_MS the seconds the page
 * was visible with someone at it (a key, a scroll, the pointer or a touch
 * in the last READING_IDLE_MS, or the focus in the embedded PDF, whose
 * events the page never sees). A switch to another document, a hidden tab
 * or leaving the page sends what is left. `url` is the document's reading
 * endpoint, or null while there is nothing published to report.
 *
 * Client only, and silent: a failure never shows.
 */
export function useDocumentReading(url: MaybeRefOrGetter<string | null>): void {
  if (import.meta.server) return;

  const { send } = useApi();
  let current: string | null = null;
  let pending = 0;
  let lastActivity = Date.now();
  let stopped = new Set<string>();
  let tick: ReturnType<typeof setInterval> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  function active(): boolean {
    if (document.visibilityState !== "visible") return false;
    const focusInFrame =
      document.hasFocus() && document.activeElement?.tagName === "IFRAME";
    return focusInFrame || Date.now() - lastActivity < READING_IDLE_MS;
  }

  function post(
    target: string,
    opened: boolean,
    seconds: number,
    last = false,
  ) {
    if (stopped.has(target)) return;
    send(target, {
      body: { opened, seconds },
      ...(last ? { keepalive: true } : {}),
    }).catch((error: unknown) => {
      const status = errorStatus(error);
      if (
        isIdentityChanged(error) ||
        (status !== null && FINAL_STATUSES.has(status))
      ) {
        stopped.add(target);
      }
    });
  }

  /** Sends the seconds counted for the current document. */
  function flush(last = false): void {
    if (!current || pending <= 0) return;
    const seconds = Math.min(pending, READING_BEAT_MAX_SECONDS);
    pending = 0;
    post(current, false, seconds, last);
  }

  function onActivity(): void {
    lastActivity = Date.now();
  }

  function onVisibility(): void {
    if (document.visibilityState === "hidden") flush(true);
    else lastActivity = Date.now();
  }

  function onPageHide(): void {
    flush(true);
  }

  watch(
    () => toValue(url),
    (next) => {
      flush(true);
      current = next;
      pending = 0;
      lastActivity = Date.now();
      if (next) post(next, true, 0);
    },
    { immediate: true },
  );

  onMounted(() => {
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, {
        passive: true,
        capture: true,
      });
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    tick = setInterval(() => {
      if (current && active()) pending += TICK_MS / 1000;
    }, TICK_MS);
    beat = setInterval(() => flush(), READING_BEAT_MS);
  });

  onBeforeUnmount(() => {
    flush(true);
    current = null;
    for (const name of ACTIVITY_EVENTS) {
      window.removeEventListener(name, onActivity, { capture: true });
    }
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    if (tick) clearInterval(tick);
    if (beat) clearInterval(beat);
    stopped = new Set();
  });
}
