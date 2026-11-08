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

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

let client: pg.Client | null = null;
let stopped = false;
let retryDelay = INITIAL_RETRY_MS;
/** The one pending reconnect; there is never more than one. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function connect(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || stopped) return;

  const next = new pg.Client({ connectionString });

  // A failed connection can report itself up to three times ("error", "end"
  // and the rejected connect). Only the first counts: answering each one
  // used to schedule three reconnects per failure, which multiplied every
  // round while the database was down until the process ran out of memory.
  let failed = false;
  const fail = (error?: unknown) => {
    if (failed) return;
    failed = true;
    if (error !== undefined) logError("live.hub", error);
    retire(next);
    scheduleReconnect();
  };

  next.on("notification", (notification) => {
    if (notification.channel !== LIVE_CHANNEL || !notification.payload) return;
    try {
      const message = JSON.parse(notification.payload) as LiveMessage;
      emitter.emit(message.assemblyId, message);
    } catch (error) {
      logWarn("live.hub", { reason: "invalid payload", error: String(error) });
    }
  });
  next.on("error", (error) => fail(error));
  next.on("end", () => fail());

  try {
    await next.connect();
    await next.query(`LISTEN ${LIVE_CHANNEL}`);
    if (failed || stopped) {
      if (!failed) retire(next);
      return;
    }
    client = next;
    retryDelay = INITIAL_RETRY_MS;
    logInfo("live.hub", { message: "listening" });
  } catch (error) {
    fail(error);
  }
}

/**
 * Drops a client for good. A late "error" on it must still have a listener,
 * or Node throws it as an uncaught exception.
 */
function retire(old: pg.Client): void {
  if (client === old) client = null;
  old.removeAllListeners();
  old.on("error", () => undefined);
  old.end().catch(() => undefined);
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

export async function startLiveHub(): Promise<void> {
  stopped = false;
  if (!client && !reconnectTimer) await connect();
}

export async function stopLiveHub(): Promise<void> {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  retryDelay = INITIAL_RETRY_MS;
  const current = client;
  client = null;
  if (current) {
    current.removeAllListeners();
    current.on("error", () => undefined);
    await current.end().catch(() => undefined);
  }
}

export function subscribeToAssembly(
  assemblyId: string,
  listener: (message: LiveMessage) => void,
): () => void {
  emitter.on(assemblyId, listener);
  return () => emitter.off(assemblyId, listener);
}
