import {
  createEventStream,
  defineEventHandler,
  getRouterParam,
  type EventStreamMessage,
} from "h3";
import { requireActor } from "../../../utils/domain/actor";
import { toLiveEventDto } from "../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import type { AuthEventContext } from "../../../utils/auth/requireAuth";
import { subscribeToAssembly } from "../../../utils/live/hub";
import {
  subscribeToLivePointer,
  subscribeToLiveScroll,
  subscribeToLiveTally,
} from "../../../utils/live/scroll";
import { markSeen } from "../../../utils/live/online";
import {
  LIVE_HEARTBEAT_INTERVAL_MS,
  liveHeartbeat,
} from "../../../utils/live/sse";

/** Reconnection delay suggested to EventSource clients. */
const RETRY_MS = 5_000;

/**
 * Live updates of one assembly as server-sent events:
 * - `ready` once connected;
 * - `change` with a LiveEventDto for every recorded event (ids only: clients
 *   refetch through the permission-checked endpoints);
 * - `scroll` with a LiveScrollDto whenever the Mesa scrolls the document in
 *   debate (server/utils/live/scroll.ts), never recorded;
 * - `pointer` with a LivePointerDto as the Mesa points or draws on it;
 * - `tally` with a LiveTallyDto as the Mesa counts a secret vote;
 * - a `ping` heartbeat every 25 s (liveHeartbeat), which clients use to
 *   tell a live stream from one that died in silence, and which keeps the
 *   viewer online (server/utils/live/online.ts) while the page stays open.
 */
export default defineEventHandler(async (event) => {
  // Resolve first, so a 401 or 404 still answers as plain JSON.
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );

  const stream = createEventStream(event);
  // Never await a push before send(): nothing reads the stream until then.
  // Writes to a dropped connection reject, so every push is caught here.
  const push = (message: EventStreamMessage) => {
    stream.push(message).catch(() => undefined);
  };

  const unsubscribe = subscribeToAssembly(assembly.id, (message) => {
    push({ event: "change", data: JSON.stringify(toLiveEventDto(message)) });
  });
  const unsubscribeScroll = subscribeToLiveScroll(assembly.id, (scroll) => {
    push({ event: "scroll", data: JSON.stringify(scroll) });
  });
  const unsubscribeTally = subscribeToLiveTally(assembly.id, (tally) => {
    push({ event: "tally", data: JSON.stringify(tally) });
  });
  const unsubscribePointer = subscribeToLivePointer(assembly.id, (pointer) => {
    push({ event: "pointer", data: JSON.stringify(pointer) });
  });
  // A page with the stream open keeps its person online while idle; the
  // real user, never the account an Admin acts as.
  const viewerId = (event.context as AuthEventContext).realUser?.id ?? null;
  const heartbeat = setInterval(() => {
    push(liveHeartbeat());
    if (viewerId) markSeen(viewerId);
  }, LIVE_HEARTBEAT_INTERVAL_MS);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeScroll();
    unsubscribePointer();
    unsubscribeTally();
    stream.close().catch(() => undefined);
  };
  stream.onClosed(cleanup);
  // onClosed only fires when the writer closes cleanly; also watch the socket.
  event.node.req.on("close", cleanup);

  push({
    event: "ready",
    retry: RETRY_MS,
    data: JSON.stringify({ assemblyId: assembly.id }),
  });
  return stream.send();
});
