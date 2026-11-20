import type { EventStreamMessage } from "h3";

/** How often the live stream sends a `ping`. */
export const LIVE_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * The heartbeat of the live stream: a named `ping` event, not an SSE
 * comment. It keeps proxies from closing an idle connection and, unlike a
 * comment (which EventSource never hands to JavaScript), it tells the client
 * the stream is still alive, so a connection that died in silence is found
 * and reopened (useAssemblyLive). `data` is never empty: an event without
 * data is not dispatched. Listeners of `change` never see it.
 */
export function liveHeartbeat(now = Date.now()): EventStreamMessage {
  return { event: "ping", data: String(now) };
}

const serialized = new WeakMap<object, string>();

/**
 * `JSON.stringify(serialize(value))`, worked out once per value: a live
 * message, scroll, pointer or tally reaches every open stream of the
 * assembly as the same object (one EventEmitter emit), so a room of a
 * hundred streams serializes it once instead of once per stream.
 * `serialize` must depend on `value` alone.
 */
export function serializeOnce<T extends object>(
  value: T,
  serialize: (value: T) => unknown = (item) => item,
): string {
  let data = serialized.get(value);
  if (data === undefined) {
    data = JSON.stringify(serialize(value));
    serialized.set(value, data);
  }
  return data;
}

/** The pushes a live stream may leave out (LIVE_PUSH_CHANNELS). */
export type LivePushChannel = "scroll" | "pointer" | "tally" | "state";

export const LIVE_PUSH_CHANNELS: readonly LivePushChannel[] = [
  "scroll",
  "pointer",
  "tally",
  "state",
];

/**
 * What a page that names no channel gets: the pushes there were before
 * `?channels=` existed. Never `state`, which such a page has no handler
 * for: each one would only make the server load the live state for it.
 */
export const LEGACY_PUSH_CHANNELS: readonly LivePushChannel[] = [
  "scroll",
  "pointer",
  "tally",
];

/**
 * The pushes a stream asked for (`?channels=scroll,pointer`): only the
 * projection follows the Mesa's pointer and the count of a secret vote,
 * and the live view its scroll, so every other page leaves them out
 * (useAssemblyLive asks for those it has a handler for); `state` is the
 * live state itself after each change (./statePush.ts). Without the
 * parameter (a page still on code from before it existed), scroll, pointer
 * and tally. Unknown names are ignored; `change`, `ready` and `ping`
 * always come.
 */
export function livePushChannels(query: unknown): ReadonlySet<LivePushChannel> {
  if (typeof query !== "string") return new Set(LEGACY_PUSH_CHANNELS);
  const asked = new Set(query.split(",").map((name) => name.trim()));
  return new Set(LIVE_PUSH_CHANNELS.filter((name) => asked.has(name)));
}
