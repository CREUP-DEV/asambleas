import {
  createEventStream,
  defineEventHandler,
  getQuery,
  getRouterParam,
  type EventStreamMessage,
} from "h3";
import { requireActor } from "../../../utils/domain/actor";
import { toLiveEventDto } from "../../../utils/domain/assemblies";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import type { AuthEventContext } from "../../../utils/auth/requireAuth";
import { liveMessageReaches } from "../../../utils/live/audienceFilter";
import { subscribeToAssembly } from "../../../utils/live/hub";
import {
  subscribeToLivePointer,
  subscribeToLiveScroll,
  subscribeToLiveTally,
} from "../../../utils/live/scroll";
import { markSeen } from "../../../utils/live/online";
import { subscribeToLiveState } from "../../../utils/live/statePush";
import {
  LIVE_HEARTBEAT_INTERVAL_MS,
  liveHeartbeat,
  livePushChannels,
  serializeOnce,
} from "../../../utils/live/sse";

/** Reconnection delay suggested to EventSource clients. */
const RETRY_MS = 5_000;

/**
 * Live updates of one assembly as server-sent events:
 * - `ready` once connected;
 * - `change` with a LiveEventDto for every recorded event (ids only: clients
 *   refetch through the permission-checked endpoints), but an amendment
 *   event whose audience leaves this actor out (a draft or an unpublished
 *   amendment it cannot see: liveMessageReaches; the actor is the one the
 *   stream opened with, so a new role applies on reconnection);
 * - `scroll` with a LiveScrollDto whenever the Mesa scrolls the document in
 *   debate (server/utils/live/scroll.ts), never recorded;
 * - `pointer` with a LivePointerDto as the Mesa points or draws on it;
 * - `tally` with a LiveTallyDto as the Mesa counts a secret vote;
 * - `state` with a LiveStatePushDto after each `live_changed`: the live
 *   state itself, the same for every reader, loaded once for every stream
 *   (server/utils/live/statePush.ts), with a point vote's question taken
 *   out unless its item's title is public (`voteQuestionRedacted`). It
 *   always follows the `change` it answers;
 * - a `ping` heartbeat every 25 s (liveHeartbeat), which clients use to
 *   tell a live stream from one that died in silence, and which keeps the
 *   viewer online (server/utils/live/online.ts) while the page stays open.
 * `?channels=` lists which of `scroll`, `pointer`, `tally` and `state` the
 * page follows (livePushChannels); without it, the first three. Each
 * message is serialized once for every stream (serializeOnce).
 */
export default defineEventHandler(async (event) => {
  // Resolve first, so a 401 or 404 still answers as plain JSON.
  const actor = await requireActor(event);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const channels = livePushChannels(getQuery(event).channels);

  const stream = createEventStream(event);
  // Never await a push before send(): nothing reads the stream until then.
  // Writes to a dropped connection reject, so every push is caught here.
  const push = (message: EventStreamMessage) => {
    stream.push(message).catch(() => undefined);
  };

  const unsubscribes: (() => void)[] = [
    subscribeToAssembly(assembly.id, (message) => {
      if (!liveMessageReaches(actor, message)) return;
      push({ event: "change", data: serializeOnce(message, toLiveEventDto) });
    }),
  ];
  if (channels.has("state")) {
    unsubscribes.push(
      subscribeToLiveState(assembly.id, (state) => {
        push({ event: "state", data: serializeOnce(state) });
      }),
    );
  }
  if (channels.has("scroll")) {
    unsubscribes.push(
      subscribeToLiveScroll(assembly.id, (scroll) => {
        push({ event: "scroll", data: serializeOnce(scroll) });
      }),
    );
  }
  if (channels.has("tally")) {
    unsubscribes.push(
      subscribeToLiveTally(assembly.id, (tally) => {
        push({ event: "tally", data: serializeOnce(tally) });
      }),
    );
  }
  if (channels.has("pointer")) {
    unsubscribes.push(
      subscribeToLivePointer(assembly.id, (pointer) => {
        push({ event: "pointer", data: serializeOnce(pointer) });
      }),
    );
  }
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
    for (const unsubscribe of unsubscribes) unsubscribe();
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
