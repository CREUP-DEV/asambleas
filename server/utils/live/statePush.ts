import { EventEmitter } from "node:events";
import type { LiveStatePushDto } from "~~/shared/types/api";
import { logError } from "../core/logger";
import type { LiveMessage } from "../domain/events";
import { subscribeToAssembly } from "./hub";
import { loadPublicLiveState } from "./liveState";

/**
 * The live state pushed whole to the streams that ask for it
 * (`?channels=state`, GET .../live): every move of the Mesa used to make
 * each device of the room read it again (some 56 GET per move, the most
 * frequent event of a session), though it is the same for everyone. The
 * notification stays ids only (pg_notify's 8000 bytes, and the other
 * listeners); this process, which holds the streams, loads the state once
 * per change after it was committed (the hub only hears committed events)
 * and sends that one copy to every stream of the assembly (serializeOnce).
 *
 * It goes as someone who sees only what is public reads it
 * (loadPublicLiveState): a point vote whose item's title is not public
 * goes without its question and says so (`voteQuestionRedacted`), and
 * clients then read GET .../live-state, which answers each reader as it
 * may see it.
 */

/** Whether a committed event moved the live state. */
export function isLiveStateChange(
  message: Pick<LiveMessage, "entityType" | "type">,
): boolean {
  return message.entityType === "live" && message.type === "live_changed";
}

/**
 * One load in flight per key, whatever the number of requests: a request
 * that comes while one is loading makes it load again once it ends, and
 * only the last load is delivered, the one that started after every
 * request so far. Loads of a key never overlap, so each reads the database
 * after the one before it: a state is never delivered after a newer one. A
 * failed load delivers nothing (clients then read the state themselves).
 */
export function coalescedLoader<T>(options: {
  load: (key: string) => Promise<T>;
  deliver: (key: string, value: T) => void;
  onError: (key: string, error: unknown) => void;
}): (key: string) => void {
  const flights = new Map<string, { again: boolean }>();

  async function run(key: string, flight: { again: boolean }): Promise<void> {
    try {
      for (;;) {
        flight.again = false;
        let loaded: { value: T } | null = null;
        try {
          loaded = { value: await options.load(key) };
        } catch (error) {
          options.onError(key, error);
        }
        // A newer request came meanwhile: this load may have missed it.
        if (flight.again) continue;
        if (loaded) {
          try {
            options.deliver(key, loaded.value);
          } catch (error) {
            options.onError(key, error);
          }
        }
        return;
      }
    } finally {
      flights.delete(key);
    }
  }

  return (key) => {
    const flight = flights.get(key);
    if (flight) {
      flight.again = true;
      return;
    }
    const next = { again: false };
    flights.set(key, next);
    void run(key, next);
  };
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** The hub subscription of each assembly with at least one listener. */
const hubSubscriptions = new Map<string, () => void>();

const requestState = coalescedLoader<LiveStatePushDto>({
  load: (assemblyId) => loadPublicLiveState(assemblyId),
  // The last stream may have closed while it loaded.
  deliver: (assemblyId, push) => {
    if (emitter.listenerCount(assemblyId) > 0) emitter.emit(assemblyId, push);
  },
  onError: (assemblyId, error) => logError("live.state", error, { assemblyId }),
});

/**
 * The live state of the assembly after each of its changes, one object
 * for every listener. Nothing is loaded for an assembly nobody listens to.
 */
export function subscribeToLiveState(
  assemblyId: string,
  listener: (push: LiveStatePushDto) => void,
): () => void {
  emitter.on(assemblyId, listener);
  if (!hubSubscriptions.has(assemblyId)) {
    hubSubscriptions.set(
      assemblyId,
      subscribeToAssembly(assemblyId, (message) => {
        if (isLiveStateChange(message)) requestState(assemblyId);
      }),
    );
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    emitter.off(assemblyId, listener);
    if (emitter.listenerCount(assemblyId) > 0) return;
    hubSubscriptions.get(assemblyId)?.();
    hubSubscriptions.delete(assemblyId);
  };
}
