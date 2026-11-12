import { PgBoss } from "pg-boss";
import { logError, logInfo } from "../core/logger";
import { subscribeToAll } from "../live/hub";
import { closeMailer, readSmtpConfig } from "./mailer";
import { NOTIFYING_EVENT_TYPES } from "./triggers";
import {
  processOutbox,
  releaseStaleClaims,
  sendDigests,
  sendImmediate,
} from "./sender";
import { NOTIFICATION_DIGEST_CRON } from "~~/shared/constants/notifications";

/**
 * Runs the email sender in the app process (server/plugins/notifications.ts):
 * - a pass right after every committed event that may notify (the live
 *   hub's LISTEN, debounced), and one every SWEEP_MS whatever happens, for
 *   retries and for events another process committed while this one was
 *   reconnecting;
 * - the daily summaries, a pg-boss schedule at NOTIFICATION_DIGEST_CRON
 *   (Europe/Madrid), on its own instance like the intranet jobs.
 */

const SWEEP_MS = 30_000;
const DEBOUNCE_MS = 1_500;

export const NOTIFICATION_DIGEST_QUEUE = "notifications-digest";
const TIMEZONE = "Europe/Madrid";
const PG_BOSS_SCHEMA = "pgboss";
const START_ATTEMPTS = 20;

let sweep: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let running: Promise<void> | null = null;
let again = false;
let stopped = false;
let boss: PgBoss | null = null;

/** One pass: the outbox, then the due immediate emails, until both are dry. */
async function pass(): Promise<void> {
  for (let round = 0; round < 20 && !stopped; round += 1) {
    const read = await processOutbox();
    const sent = await sendImmediate();
    if (read === 0 && sent === 0) return;
  }
}

/** Runs a pass, or asks the running one to go round once more. */
export function kickNotifications(): void {
  if (stopped) return;
  if (running) {
    again = true;
    return;
  }
  running = pass()
    .catch((error) => logError("email.runner", error))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        kickNotifications();
      }
    });
}

async function startDigestSchedule(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;
  const instance = new PgBoss({
    connectionString,
    schema: PG_BOSS_SCHEMA,
    max: 2,
  });
  instance.on("error", (error) => logError("email.digest", error));
  try {
    await instance.start({ attempts: START_ATTEMPTS });
    await instance.createQueue(NOTIFICATION_DIGEST_QUEUE, {
      retryLimit: 2,
      retryDelay: 15 * 60,
      expireInSeconds: 60 * 60,
      deleteAfterSeconds: 30 * 24 * 3600,
    });
    await instance.schedule(
      NOTIFICATION_DIGEST_QUEUE,
      NOTIFICATION_DIGEST_CRON,
      null,
      // A server that was down at that hour sends them once it is back.
      { tz: TIMEZONE, missed: "once" },
    );
    await instance.work<unknown>(
      NOTIFICATION_DIGEST_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 60 },
      async () => {
        const sent = await sendDigests();
        logInfo("email.digest", { sent });
      },
    );
    boss = instance;
    logInfo("email.digest", {
      state: "scheduled",
      cron: NOTIFICATION_DIGEST_CRON,
      timezone: TIMEZONE,
    });
  } catch (error) {
    logError("email.digest", error);
    await instance.stop({ graceful: false }).catch(() => undefined);
  }
}

export async function startNotifications(): Promise<void> {
  stopped = false;
  await releaseStaleClaims().catch((error) => logError("email.runner", error));
  unsubscribe = subscribeToAll((message) => {
    if (!NOTIFYING_EVENT_TYPES.has(message.type)) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      kickNotifications();
    }, DEBOUNCE_MS);
  });
  sweep = setInterval(kickNotifications, SWEEP_MS);
  sweep.unref?.();
  kickNotifications();
  const config = readSmtpConfig();
  logInfo("email.runner", {
    state: "started",
    smtp: config ? `${config.host}:${config.port}` : "unconfigured",
  });
  void startDigestSchedule();
}

export async function stopNotifications(): Promise<void> {
  stopped = true;
  unsubscribe?.();
  unsubscribe = null;
  if (sweep) clearInterval(sweep);
  if (debounce) clearTimeout(debounce);
  sweep = null;
  debounce = null;
  await running;
  await boss?.stop().catch(() => undefined);
  boss = null;
  closeMailer();
}
