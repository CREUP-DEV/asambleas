import { EventEmitter } from "node:events";
import type { LiveScrollDto } from "~~/shared/types/api";

/**
 * Where the Mesa has the document in debate scrolled, so the projection
 * shows the same part (user's decision of 2026-11-18). Several times a
 * second while the Mesa scrolls, so it never touches the database nor the
 * history: it lives in this process's memory (one app container, like the
 * editors' presence) and goes to the SSE streams of the assembly as a
 * `scroll` event of their own, never as a `change` (which would make every
 * client refetch). A restart forgets it; the projection then stays where
 * it is until the Mesa scrolls again.
 */

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const latest = new Map<string, LiveScrollDto>();

/** Keeps the position and sends it to the assembly's streams. */
export function publishLiveScroll(
  assemblyId: string,
  scroll: LiveScrollDto,
): void {
  latest.set(assemblyId, scroll);
  emitter.emit(assemblyId, scroll);
}

/** The last position the Mesa sent for this assembly, if any. */
export function readLiveScroll(assemblyId: string): LiveScrollDto | null {
  return latest.get(assemblyId) ?? null;
}

export function subscribeToLiveScroll(
  assemblyId: string,
  listener: (scroll: LiveScrollDto) => void,
): () => void {
  emitter.on(assemblyId, listener);
  return () => emitter.off(assemblyId, listener);
}

/** Forgets every position (tests). */
export function clearLiveScrollForTests(): void {
  latest.clear();
  emitter.removeAllListeners();
}
