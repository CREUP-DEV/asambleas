import type { MaybeRefOrGetter, Ref } from "vue";
import type { LiveEventDto } from "~~/shared/types/api";
import {
  LIVE_ONLINE_JITTER_MS,
  LIVE_WATCHDOG_TICK_MS,
  isLiveStreamStale,
  shouldReopenOnRestore,
  shouldReopenOnShow,
} from "./-watchdog";

/** Quiet period before a burst of changes is delivered as one batch. */
const DEBOUNCE_MS = 300;
/** A steady stream of changes is still delivered at least this often. */
const MAX_WAIT_MS = 1_500;
/** First reconnect delay; it doubles on every failure up to the cap. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Consecutive failures after which the client also polls. */
const FAILURES_BEFORE_POLLING = 3;
const POLL_INTERVAL_MS = 15_000;

/** The synthetic event delivered when the client must refetch everything. */
export function livePollEvent(assemblyId: string): LiveEventDto {
  return { type: "poll", entityType: "assembly", entityId: assemblyId };
}

function parseChange(data: unknown): LiveEventDto | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as Partial<LiveEventDto> | null;
    if (
      !value ||
      typeof value.type !== "string" ||
      typeof value.entityType !== "string" ||
      typeof value.entityId !== "string"
    ) {
      return null;
    }
    return {
      type: value.type,
      entityType: value.entityType,
      entityId: value.entityId,
      ...(typeof value.documentId === "string"
        ? { documentId: value.documentId }
        : {}),
    };
  } catch {
    return null;
  }
}

function dedupe(events: LiveEventDto[]): LiveEventDto[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.entityType}|${event.entityId}|${event.type}|${event.documentId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Live updates of one assembly through GET /api/assemblies/{id}/live (SSE).
 *
 * - Bursts are coalesced: `onChange` receives the distinct events of a burst
 *   once things settle for 300 ms (at most 1.5 s after the first one).
 * - Lost connections reconnect with exponential backoff. After 3 failures in a
 *   row it also polls: every 15 s `onChange` receives a single
 *   `{ type: "poll", entityType: "assembly", entityId }` event, meaning
 *   "refetch everything". It keeps trying the stream and stops polling as soon
 *   as the stream is back.
 * - Once the stream is ready a `poll` event is delivered too: after a
 *   reconnection, since changes made while disconnected were never received,
 *   and after the first connection, since changes made between the page's
 *   own fetch (SSR or client) and the stream's `ready` were never sent.
 * - A stream that died in silence is found (./-watchdog.ts): the server
 *   sends a `ping` every 25 s, and a visible page that heard nothing for a
 *   minute counts it as a failure and reconnects. A page shown again after
 *   a long hide whose stream missed a heartbeat, a page restored from the
 *   browser's cache and a network that comes back reopen it at once. So
 *   `connected` stays true only while messages keep arriving.
 * - Client-only. Closes the stream when the id changes and when the calling
 *   scope (component) is disposed. An undefined id means "not connected".
 *
 * Events carry ids only; refetch through the normal endpoints.
 */
export function useAssemblyLive(
  assemblyId: MaybeRefOrGetter<string | undefined>,
  onChange: (events: LiveEventDto[]) => void,
): { connected: Readonly<Ref<boolean>>; polling: Readonly<Ref<boolean>> } {
  const connected = ref(false);
  const polling = ref(false);
  const result = { connected: readonly(connected), polling: readonly(polling) };
  if (import.meta.server) return result;

  let source: EventSource | null = null;
  let activeId: string | undefined;
  /**
   * Bumped on every teardown so handlers of a closed stream do nothing; a
   * stream replaced within the same generation (reopen) is told by `source`.
   */
  let generation = 0;
  let failures = 0;
  let missedChanges = false;
  let pending: LiveEventDto[] = [];
  /** When the open stream last delivered anything (ready, change or ping). */
  let lastMessageAt = 0;
  /** When the current stream was opened (null until one is). */
  let openedAt: number | null = null;
  /** When the page was hidden, while it is. */
  let hiddenAt: number | null =
    document.visibilityState === "hidden" ? Date.now() : null;

  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;

  function clearFlushTimers(): void {
    clearTimeout(flushTimer);
    clearTimeout(maxWaitTimer);
    flushTimer = undefined;
    maxWaitTimer = undefined;
  }

  function deliver(): void {
    clearFlushTimers();
    if (pending.length === 0) return;
    const batch = dedupe(pending);
    pending = [];
    try {
      onChange(batch);
    } catch (error) {
      console.error("[live] change handler failed", error);
    }
  }

  function enqueue(event: LiveEventDto): void {
    pending.push(event);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(deliver, DEBOUNCE_MS);
    maxWaitTimer ??= setTimeout(deliver, MAX_WAIT_MS);
  }

  function startPolling(id: string): void {
    if (pollTimer) return;
    polling.value = true;
    pollTimer = setInterval(() => enqueue(livePollEvent(id)), POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    clearInterval(pollTimer);
    pollTimer = undefined;
    polling.value = false;
  }

  function closeSource(): void {
    source?.close();
    source = null;
  }

  function scheduleReconnect(id: string, gen: number): void {
    clearTimeout(reconnectTimer);
    const exponent = Math.min(failures - 1, 10);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** exponent, RECONNECT_MAX_MS);
    // Jitter keeps a room full of delegates from reconnecting in lockstep.
    const jittered = delay * (0.8 + Math.random() * 0.4);
    reconnectTimer = setTimeout(() => {
      if (gen === generation) open(id, gen);
    }, jittered);
  }

  /**
   * A stream that failed (an error, or silence): drop it, mark the gap for
   * the next `ready` and retry with backoff, polling after a few failures.
   */
  function fail(id: string, gen: number): void {
    // Take over from the browser's own retry, so the backoff and the
    // failure count stay under our control.
    closeSource();
    connected.value = false;
    missedChanges = true;
    failures += 1;
    if (failures >= FAILURES_BEFORE_POLLING) startPolling(id);
    scheduleReconnect(id, gen);
  }

  /**
   * Reopens the stream without counting a failure (the page is back, or the
   * network): now, or after `delayMs`. The next `ready` refetches.
   */
  function reopen(delayMs = 0): void {
    const id = activeId;
    if (!id) return;
    const gen = generation;
    closeSource();
    clearTimeout(reconnectTimer);
    connected.value = false;
    missedChanges = true;
    if (delayMs <= 0) {
      open(id, gen);
      return;
    }
    reconnectTimer = setTimeout(() => {
      if (gen === generation) open(id, gen);
    }, delayMs);
  }

  function open(id: string, gen: number): void {
    closeSource();
    // The silence is counted from the moment the stream opens.
    lastMessageAt = Date.now();
    openedAt = lastMessageAt;
    let stream: EventSource;
    try {
      stream = new EventSource(
        `/api/assemblies/${encodeURIComponent(id)}/live`,
        { withCredentials: true },
      );
    } catch {
      failures += 1;
      if (failures >= FAILURES_BEFORE_POLLING) startPolling(id);
      scheduleReconnect(id, gen);
      return;
    }
    source = stream;

    stream.addEventListener("ready", () => {
      if (gen !== generation || source !== stream) return;
      lastMessageAt = Date.now();
      connected.value = true;
      const resync = missedChanges;
      failures = 0;
      missedChanges = false;
      stopPolling();
      if (resync) enqueue(livePollEvent(id));
    });

    stream.addEventListener("change", (event) => {
      if (gen !== generation || source !== stream) return;
      lastMessageAt = Date.now();
      const change = parseChange((event as MessageEvent).data);
      if (change) enqueue(change);
    });

    // The heartbeat: nothing to deliver, only proof the stream is alive.
    stream.addEventListener("ping", () => {
      if (gen !== generation || source !== stream) return;
      lastMessageAt = Date.now();
    });

    stream.addEventListener("error", () => {
      if (gen !== generation || source !== stream) return;
      fail(id, gen);
    });
  }

  function watchdogTick(): void {
    if (!activeId) return;
    const stale = isLiveStreamStale({
      now: Date.now(),
      lastMessageAt,
      visible: document.visibilityState === "visible",
      streaming: source !== null,
    });
    if (stale) fail(activeId, generation);
  }

  function teardown(): void {
    generation += 1;
    closeSource();
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearInterval(watchdogTimer);
    watchdogTimer = undefined;
    stopPolling();
    clearFlushTimers();
    pending = [];
    failures = 0;
    missedChanges = false;
    connected.value = false;
    activeId = undefined;
  }

  function connect(id: string): void {
    teardown();
    activeId = id;
    // The stream has no replay: anything recorded since the page fetched its
    // data and before `ready` is lost, so resync once the stream is ready.
    missedChanges = true;
    open(id, generation);
    watchdogTimer = setInterval(watchdogTick, LIVE_WATCHDOG_TICK_MS);
  }

  // Back online: the old socket may be dead even if it looks open, so
  // always reopen, a little apart from everyone else in the room.
  function onOnline(): void {
    reopen(Math.random() * LIVE_ONLINE_JITTER_MS);
  }

  function onVisibilityChange(): void {
    if (document.visibilityState !== "visible") {
      hiddenAt ??= Date.now();
      return;
    }
    const since = hiddenAt;
    hiddenAt = null;
    if (
      activeId &&
      shouldReopenOnShow({
        now: Date.now(),
        hiddenAt: since,
        lastMessageAt,
        streaming: source !== null,
      })
    ) {
      reopen();
    }
  }

  // Restored from the browser's page cache: whatever the stream was, it
  // missed everything in between. The visibility handler may have reopened
  // it a moment ago (browsers fire the two in either order): one is enough.
  function onPageShow(event: PageTransitionEvent): void {
    if (
      shouldReopenOnRestore({
        persisted: event.persisted,
        now: Date.now(),
        openedAt,
      })
    ) {
      reopen();
    }
  }

  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", onPageShow);

  const stopWatch = watch(
    () => toValue(assemblyId),
    (id) => {
      if (id === activeId) return;
      if (id) connect(id);
      else teardown();
    },
    { immediate: true },
  );

  if (getCurrentScope()) {
    onScopeDispose(() => {
      stopWatch();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      teardown();
    });
  }

  return result;
}
