import { EventEmitter } from "node:events";
import type {
  LivePointerDto,
  LiveScrollDto,
  LiveTallyDto,
} from "~~/shared/types/api";

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

/**
 * What the Mesa's pointer does on the document in debate: sent to the
 * assembly's streams as a `pointer` event and forgotten, like a scroll but
 * never kept (a projection that opens late misses only a few strokes).
 */
export function publishLivePointer(
  assemblyId: string,
  pointer: LivePointerDto,
): void {
  emitter.emit(`pointer:${assemblyId}`, pointer);
}

export function subscribeToLivePointer(
  assemblyId: string,
  listener: (pointer: LivePointerDto) => void,
): () => void {
  emitter.on(`pointer:${assemblyId}`, listener);
  return () => emitter.off(`pointer:${assemblyId}`, listener);
}

/**
 * A secret vote's running count: the last one is kept (a projection that
 * opens mid-count reads it) and sent to the streams as a `tally` event;
 * null ends it. Memory only, like the scroll: the vote itself is recorded
 * once counted.
 */
const tallies = new Map<string, LiveTallyDto>();

export function publishLiveTally(
  assemblyId: string,
  tally: LiveTallyDto,
): void {
  if (tally.tally) tallies.set(assemblyId, tally);
  else tallies.delete(assemblyId);
  emitter.emit(`tally:${assemblyId}`, tally);
}

export function readLiveTally(assemblyId: string): LiveTallyDto | null {
  return tallies.get(assemblyId) ?? null;
}

export function subscribeToLiveTally(
  assemblyId: string,
  listener: (tally: LiveTallyDto) => void,
): () => void {
  emitter.on(`tally:${assemblyId}`, listener);
  return () => emitter.off(`tally:${assemblyId}`, listener);
}

/** Forgets every position and count (tests). */
export function clearLiveScrollForTests(): void {
  latest.clear();
  tallies.clear();
  emitter.removeAllListeners();
}
