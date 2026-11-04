import { EventEmitter } from "node:events";
import pg from "pg";
import { logError, logInfo, logWarn } from "../core/logger";
import { LIVE_CHANNEL, type LiveMessage } from "../domain/events";

/**
 * Fans Postgres notifications out to the SSE streams of this process. Works
 * across several app instances because every instance LISTENs on its own
 * connection. No Redis involved.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let client: pg.Client | null = null;
let stopped = false;
let retryDelay = 1_000;

async function connect(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || stopped) return;

  const next = new pg.Client({ connectionString });
  next.on("notification", (notification) => {
    if (notification.channel !== LIVE_CHANNEL || !notification.payload) return;
    try {
      const message = JSON.parse(notification.payload) as LiveMessage;
      emitter.emit(message.assemblyId, message);
    } catch (error) {
      logWarn("live.hub", { reason: "invalid payload", error: String(error) });
    }
  });
  next.on("error", (error) => {
    logError("live.hub", error);
    scheduleReconnect();
  });
  next.on("end", () => scheduleReconnect());

  try {
    await next.connect();
    await next.query(`LISTEN ${LIVE_CHANNEL}`);
    client = next;
    retryDelay = 1_000;
    logInfo("live.hub", { message: "listening" });
  } catch (error) {
    logError("live.hub", error);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (stopped) return;
  const previous = client;
  client = null;
  previous?.removeAllListeners();
  previous?.end().catch(() => undefined);
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, 30_000);
  setTimeout(() => {
    void connect();
  }, delay);
}

export async function startLiveHub(): Promise<void> {
  stopped = false;
  if (!client) await connect();
}

export async function stopLiveHub(): Promise<void> {
  stopped = true;
  await client?.end().catch(() => undefined);
  client = null;
}

export function subscribeToAssembly(
  assemblyId: string,
  listener: (message: LiveMessage) => void,
): () => void {
  emitter.on(assemblyId, listener);
  return () => emitter.off(assemblyId, listener);
}
