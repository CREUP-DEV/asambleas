import {
  createEventStream,
  defineEventHandler,
  getRouterParam,
  type EventStream,
  type EventStreamMessage,
} from "h3";
import { requireActor } from "../../../utils/domain/actor";
import { toLiveEventDto } from "../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { subscribeToAssembly } from "../../../utils/live/hub";

const HEARTBEAT_INTERVAL_MS = 25_000;
/** Reconnection delay suggested to EventSource clients. */
const RETRY_MS = 5_000;

/**
 * Writes an SSE comment line (`: text`), which keeps proxies from closing an
 * idle connection without firing any event in the browser. h3 1.x only
 * formats `data:` messages, so this goes through the stream's own writer to
 * stay ordered with the pushed events; if those internals ever change, it
 * falls back to a named `ping` event that clients ignore.
 */
function writeComment(stream: EventStream, text: string): Promise<unknown> {
  const internals = stream as unknown as {
    _writer?: WritableStreamDefaultWriter<Uint8Array>;
    _encoder?: TextEncoder;
    _writerIsClosed?: boolean;
  };
  if (internals._writer && internals._encoder) {
    if (internals._writerIsClosed) return Promise.resolve();
    return internals._writer
      .write(internals._encoder.encode(`: ${text}\n\n`))
      .catch(() => undefined);
  }
  return stream.push({ event: "ping", data: "" }).catch(() => undefined);
}

/**
 * Live updates of one assembly as server-sent events:
 * - `ready` once connected;
 * - `change` with a LiveEventDto for every recorded event (ids only: clients
 *   refetch through the permission-checked endpoints);
 * - a comment heartbeat every 25 s.
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
    void writeComment(stream, "heartbeat");
  }, HEARTBEAT_INTERVAL_MS);

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
