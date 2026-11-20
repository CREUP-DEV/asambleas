/**
 * How the hub's section pages wire their refetches to the live stream
 * (useCurrentAssembly): one refetch per fetch key and live batch that
 * never joins a read older than the batch, and the batches that arrive
 * while a page still awaits its first fetches. Pure, so it is unit-tested
 * on its own (-liveWiring.test.ts).
 *
 * The leading dash keeps Nuxt from auto-importing this file
 * (`ignorePrefix`); import it explicitly.
 */
import type { LiveEventDto } from "~~/shared/types/api";
import { trailingRefresh } from "../fetch/trailingRefresh";

/** Refetches a fetch key after a live event (CurrentAssemblyContext). */
export type LiveRefresh = (
  key: string,
  run: () => Promise<unknown>,
) => Promise<void>;

/**
 * One trailing refresh (trailingRefresh) per fetch key, shared by every
 * subscriber of the key.
 *
 * Joining a read already on its way (useFetch's `dedupe: "defer"`) may
 * show a change undone: that read may have left before the change the
 * event announces (an amendment just validated back among the pending
 * ones). Cancelling it from every subscriber instead would send one
 * request per subscriber of the key on the same batch (the agenda has
 * several on a page; the validation inbox two, the hub and its page).
 *
 * So the calls of one tick for a key share one run, and a call while that
 * run is on its way waits for it and runs once more, however many came
 * meanwhile: one request in the normal case, as with `defer`. `run` must
 * replace any other read of the key in flight
 * (`refresh({ dedupe: "cancel" })`): one started elsewhere (a first load,
 * a write's refetch) may also have left before the event. The latest
 * caller's `run` is the one used, so a run of a page already gone is
 * never kept, and a key is forgotten once nothing is pending for it.
 */
export function keyedTrailingRefresh(): LiveRefresh {
  interface Entry {
    run: () => Promise<unknown>;
    refresh: () => Promise<void>;
    last: Promise<void> | null;
  }
  const entries = new Map<string, Entry>();

  return (key, run) => {
    let entry = entries.get(key);
    if (!entry) {
      const created: Entry = {
        run,
        refresh: trailingRefresh(() => created.run()),
        last: null,
      };
      entries.set(key, created);
      entry = created;
    }
    entry.run = run;
    const done = entry.refresh();
    if (entry.last !== done) {
      const current = entry;
      current.last = done;
      void done.then(() => {
        // A call after this run settled started another: keep the key.
        if (current.last === done && entries.get(key) === current) {
          entries.delete(key);
        }
      });
    }
    return done;
  };
}

/** Subscribes a live handler; returns the unsubscribe function. */
type OnLive = (handler: (events: LiveEventDto[]) => void) => () => void;

/**
 * For a page that awaits its first fetches before its live handler can
 * exist (it reads what they returned): call before the first await. The
 * hub hands each batch only to the handlers registered when it arrives,
 * so a batch in that window would be lost, and what it changed would stay
 * stale until some later event. The returned function registers the
 * handler and hands it, as one batch, whatever arrived meanwhile; nothing
 * when nothing did, so the normal case costs no request.
 */
export function holdEarlyLive(
  onLive: OnLive,
): (handler: (events: LiveEventDto[]) => void) => () => void {
  const held: LiveEventDto[] = [];
  const offHeld = onLive((events) => {
    held.push(...events);
  });
  return (handler) => {
    offHeld();
    const off = onLive(handler);
    if (held.length > 0) {
      // As the hub does: a handler that fails never breaks its caller.
      try {
        handler(held.splice(0));
      } catch (error) {
        console.error("[assembly] live handler failed", error);
      }
    }
    return off;
  };
}
