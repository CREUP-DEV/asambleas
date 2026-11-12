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
