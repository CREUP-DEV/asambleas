/**
 * The live state pushed on the stream (`state`, useAssemblyLive's
 * onState) and read through GET .../live-state, kept in order: both carry
 * `updatedAt`, and a page keeps a state only if it is not older than the
 * one it holds (equal is fine; followLiveState says against which), but
 * for the hub's last push handed to a late handler, kept only if newer
 * than the page's read. Pure,
 * so it is unit-tested on its own
 * (-liveState.test.ts).
 *
 * The leading dash keeps Nuxt from auto-importing this file
 * (`ignorePrefix`); import it explicitly.
 */
import type {
  LiveEventDto,
  LiveStateDto,
  LiveStatePushDto,
} from "~~/shared/types/api";

type Stamped = Pick<LiveStateDto, "updatedAt">;

function stampOf(state: Stamped): number | null {
  if (state.updatedAt === null) return null;
  const time = Date.parse(state.updatedAt);
  return Number.isNaN(time) ? null : time;
}

/**
 * Whether `incoming` is older than `held`: a state without a stamp is
 * older than one with it; nothing is older than no state at all.
 */
export function isOlderLiveState(
  incoming: Stamped,
  held: Stamped | null | undefined,
): boolean {
  if (!held) return false;
  const heldStamp = stampOf(held);
  if (heldStamp === null) return false;
  const incomingStamp = stampOf(incoming);
  return incomingStamp === null || incomingStamp < heldStamp;
}

/**
 * Whether `incoming` is newer than `held`: anything is newer than no state
 * at all, a stamped state than an unstamped one; an equal stamp is not.
 */
export function isNewerLiveState(
  incoming: Stamped,
  held: Stamped | null | undefined,
): boolean {
  if (!held) return true;
  const incomingStamp = stampOf(incoming);
  if (incomingStamp === null) return false;
  const heldStamp = stampOf(held);
  return heldStamp === null || incomingStamp > heldStamp;
}

/** The `state` event's data, or null when it is not one. */
export function parseLiveStatePush(data: unknown): LiveStatePushDto | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as Partial<LiveStatePushDto> | null;
    const state = value?.state as Partial<LiveStateDto> | undefined;
    if (
      !value ||
      typeof value.voteQuestionRedacted !== "boolean" ||
      !state ||
      typeof state !== "object" ||
      !(typeof state.updatedAt === "string" || state.updatedAt === null)
    ) {
      return null;
    }
    return value as LiveStatePushDto;
  } catch {
    return null;
  }
}

/**
 * What one stream told of the live state (useAssemblyLive): whether every
 * `live` change it delivered was followed by a pushed state to apply.
 * Only then may a page skip reading the live state for a batch of them
 * (`covered`). A new stream starts uncovered; a redacted push (a point
 * vote's question taken out, `voteQuestionRedacted`) or a malformed one
 * leaves it so, and the page reads the state for its reader.
 */
export function liveStatePushTracker(): {
  reset: () => void;
  change: (event: Pick<LiveEventDto, "entityType">) => void;
  push: (data: unknown) => LiveStateDto | null;
  covered: () => boolean;
} {
  let pending = true;
  return {
    reset: () => {
      pending = true;
    },
    change: (event) => {
      if (event.entityType === "live") pending = true;
    },
    push: (data) => {
      const push = parseLiveStatePush(data);
      if (!push || push.voteQuestionRedacted) return null;
      pending = false;
      return push.state;
    },
    covered: () => !pending,
  };
}

/**
 * Up to how long a reader's live view waits before applying a pushed state
 * that moves to another document: as long as the spread of the room's
 * refetches (LIVE_SPREAD_MS in useCurrentAssembly), since every phone then
 * downloads that document and its amendments, which a read of the state
 * after the change used to spread.
 */
export const LIVE_STATE_DOCUMENT_SPREAD_MS = 1_200;

/**
 * This page's wait before applying `incoming` (followLiveState's
 * `delayMs`): a share of LIVE_STATE_DOCUMENT_SPREAD_MS, drawn by the page
 * once, when it moves to another document than `held`'s; none otherwise,
 * nor for the Mesa (`spread` false).
 */
export function liveStateDocumentDelay(
  incoming: Pick<LiveStateDto, "documentId">,
  held: Pick<LiveStateDto, "documentId"> | null | undefined,
  options: { spread: boolean; share: number },
): number {
  if (!options.spread || incoming.documentId === (held?.documentId ?? null)) {
    return 0;
  }
  return Math.round(options.share * LIVE_STATE_DOCUMENT_SPREAD_MS);
}

export interface LiveStateFollower {
  /**
   * A read's answer (GET or PUT .../live-state), to keep: itself, or the
   * newer state already pushed when a push overtook the read.
   */
  fetched: (state: LiveStateDto | null) => LiveStateDto | null;
  /**
   * A pushed state: applied now, or after `delayMs` when it asks for one;
   * one older than the last read kept is dropped. While one waits, later
   * ones replace it, so the newest is applied once and in order.
   * `replay` marks the hub's last push handed to a handler registered
   * after it (onLiveState): kept only when newer than the last read kept,
   * since the vote it carries can change without moving `updatedAt` (a
   * vote marked unanimous, moved to another subject) and with no push, so
   * at an equal stamp the page's read is the fresher one.
   */
  pushed: (state: LiveStateDto, meta?: { replay?: boolean }) => void;
  /** Drops a push still waiting. */
  dispose: () => void;
}

/**
 * Keeps a page's live state in order (`updatedAt`) between the pushes and
 * its reads. `apply` writes a pushed state where the page holds it.
 * `delayMs` lets a page wait before applying a push: Directo spreads one
 * that moves to another document over a second, since every phone of the
 * room then downloads that document and its amendments.
 *
 * Pushes arrive in the order the changes were committed (the server loads
 * them one after the other), while `updatedAt` is when the change's
 * transaction started: two writers at once may commit in one order with
 * stamps in the other. So a push is checked only against the last read the
 * page kept (a read that left before the change), never against an
 * earlier push, which it follows; the hub's last push handed to a late
 * handler (`replay`) must be newer than that read, not just as new; a
 * read is checked against everything seen.
 */
export function followLiveState(options: {
  apply: (state: LiveStateDto) => void;
  delayMs?: (state: LiveStateDto) => number;
}): LiveStateFollower {
  /** The newest state seen, read or pushed, applied or waiting. */
  let newest: LiveStateDto | null = null;
  /** The last read kept. */
  let lastRead: LiveStateDto | null = null;
  let waiting: ReturnType<typeof setTimeout> | undefined;

  function dispose(): void {
    clearTimeout(waiting);
    waiting = undefined;
  }

  return {
    fetched: (state) => {
      if (!state) return state;
      if (isOlderLiveState(state, newest)) return newest;
      newest = state;
      lastRead = state;
      // As new as anything pushed: a push still waiting has nothing to add.
      dispose();
      return state;
    },
    pushed: (state, meta) => {
      if (
        meta?.replay
          ? !isNewerLiveState(state, lastRead)
          : isOlderLiveState(state, lastRead)
      ) {
        return;
      }
      newest = state;
      if (waiting) return;
      const delay = Math.max(0, options.delayMs?.(state) ?? 0);
      if (delay === 0) {
        options.apply(state);
        return;
      }
      waiting = setTimeout(() => {
        waiting = undefined;
        if (newest) options.apply(newest);
      }, delay);
    },
    dispose,
  };
}
