import { EventEmitter } from "node:events";
import type {
  LivePointerDto,
  LiveScrollDto,
  LiveTallyDto,
} from "~~/shared/types/api";
import { LIVE_TALLY_TTL_MS } from "~~/shared/utils/schemas/assembly";

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
 * A secret vote the Mesa is counting (its announcement and, ballot by
 * ballot, its running count): the last one is kept (a projection that
 * opens mid-count reads it) and sent to the streams as a `tally` event;
 * null ends it. Memory only, like the scroll: the vote itself is recorded
 * once counted.
 *
 * The console repeats it every 15 s while its form is open, so a kept
 * count nobody has sent for LIVE_TALLY_TTL_MS ends on its own and the
 * streams are told: a console closed or crashed mid-count, or one that
 * lost control of the projection, can no longer clear it, and it would
 * otherwise cover the screen until the next result.
 */
interface KeptTally {
  dto: LiveTallyDto;
  timer: ReturnType<typeof setTimeout>;
}
const tallies = new Map<string, KeptTally>();

/**
 * The order the pushes arrived in, per assembly: a push publishes only if
 * no later one has published first (the handler awaits between arrival and
 * publishing, longer for a count that names an agenda item), so a late
 * count never lands after the null that ended it. Never reset by a null.
 */
let nextTicket = 0;
const lastTicket = new Map<string, number>();

/** Taken when a push arrives, before anything is awaited. */
export function takeLiveTallyTicket(): number {
  nextTicket += 1;
  return nextTicket;
}

function forgetTally(assemblyId: string): void {
  const kept = tallies.get(assemblyId);
  if (kept) clearTimeout(kept.timer);
  tallies.delete(assemblyId);
}

/**
 * Keeps the count (or ends it on null) and sends it to the streams.
 * `ticket` (takeLiveTallyTicket) drops a push older than one already
 * published; false when it was dropped.
 */
export function publishLiveTally(
  assemblyId: string,
  tally: LiveTallyDto,
  ticket?: number,
): boolean {
  if (ticket !== undefined) {
    if (ticket <= (lastTicket.get(assemblyId) ?? 0)) return false;
    lastTicket.set(assemblyId, ticket);
  }
  forgetTally(assemblyId);
  if (tally.tally) {
    const timer = setTimeout(() => {
      if (tallies.get(assemblyId)?.timer !== timer) return;
      tallies.delete(assemblyId);
      emitter.emit(`tally:${assemblyId}`, {
        tally: null,
        at: new Date().toISOString(),
      } satisfies LiveTallyDto);
    }, LIVE_TALLY_TTL_MS);
    timer.unref?.();
    tallies.set(assemblyId, { dto: tally, timer });
  }
  emitter.emit(`tally:${assemblyId}`, tally);
  return true;
}

/**
 * Forgets the count kept for the assembly, without telling the streams: a
 * vote's result is going on screen (pointLiveVote, projectItemVote, inside
 * the transaction that records it), so a count the console never ended (a
 * closed tab) is not read back by a projection that opens later. An open
 * projection drops its own when the vote on screen changes, which happens
 * only once the result is committed: telling it now would show the
 * previous result until then. The console still counting sends it again
 * (it repeats it while the form is open).
 */
export function endLiveTally(assemblyId: string): void {
  forgetTally(assemblyId);
}

export function readLiveTally(assemblyId: string): LiveTallyDto | null {
  return tallies.get(assemblyId)?.dto ?? null;
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
  for (const kept of tallies.values()) clearTimeout(kept.timer);
  tallies.clear();
  lastTicket.clear();
  emitter.removeAllListeners();
}
