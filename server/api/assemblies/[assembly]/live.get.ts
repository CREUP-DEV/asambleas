import {
  createEventStream,
  defineEventHandler,
  getRouterParam,
  type EventStreamMessage,
} from "h3";
import { requireActor } from "../../../utils/domain/actor";
import { toLiveEventDto } from "../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { subscribeToAssembly } from "../../../utils/live/hub";
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
 * - a `ping` heartbeat every 25 s (liveHeartbeat), which clients use to
 *   tell a live stream from one that died in silence.
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
  const heartbeat = setInterval(() => {
    push(liveHeartbeat());
  }, LIVE_HEARTBEAT_INTERVAL_MS);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
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
