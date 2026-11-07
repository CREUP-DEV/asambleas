import { PgBoss, type Job } from "pg-boss";
import { logError, logInfo, logWarn } from "../core/logger";
import {
  isAccessRecheckEnabled,
  recheckIntranetAccess,
  type AccessRecheckOutcome,
} from "../auth/accessRecheck";
import { getIntranetApiBaseUrl } from "./intranet";
import { syncIntranetRoster, type RosterSyncOutcome } from "./sync";

/**
 * The daily intranet jobs, two pg-boss schedules on one instance:
 *
 * - The roster sync runs syncIntranetRoster at 05:00 Madrid time with no
 *   actor (`trigger: "scheduled"`). It never confirms a large deactivation:
 *   such a run writes `members.sync_blocked` and logs a warning, and someone
 *   with `member:manage` runs the sync by hand from Miembros to confirm it.
 *   It runs only when NUXT_INTRANET_API_URL is usable and
 *   NUXT_INTRANET_ROSTER_SYNC is not "false".
 * - The access re-check (server/utils/auth/accessRecheck.ts) runs at 05:30:
 *   accounts with a live session that the Intranet deleted lose access. It
 *   runs whenever an authenticated role lookup is configured, whatever
 *   NUXT_INTRANET_ROSTER_SYNC says.
 *
 * Started by server/plugins/intranet-schedules.ts on its own pg-boss
 * instance, since Nitro does not await plugins and the export queue
 * memoizes its instance only once started.
 */

export const ROSTER_SYNC_QUEUE = "members-roster-sync";
/** Every day at 05:00, in ROSTER_SYNC_TIMEZONE. */
export const ROSTER_SYNC_CRON = "0 5 * * *";
export const ROSTER_SYNC_TIMEZONE = "Europe/Madrid";
/** Retries after a failed run (the intranet was down): a few, well spaced. */
export const ROSTER_SYNC_RETRY_LIMIT = 2;
const ROSTER_SYNC_RETRY_DELAY_SECONDS = 15 * 60;

export const ACCESS_RECHECK_QUEUE = "users-access-recheck";
/** Every day at 05:30, after the roster sync, in ROSTER_SYNC_TIMEZONE. */
export const ACCESS_RECHECK_CRON = "30 5 * * *";
/** Retries after a run the Intranet cut short. */
export const ACCESS_RECHECK_RETRY_LIMIT = 2;

/** Same schema as the export queue (server/utils/export/queue.ts). */
const PG_BOSS_SCHEMA = "pgboss";
/**
 * Start attempts at boot, like the export queue's: after a host reboot the
 * shared PostgreSQL may not accept connections yet, and a failed start is
 * cached, so the daily jobs would never run until the next restart.
 */
const SCHEDULE_START_ATTEMPTS = 20;

/**
 * NUXT_INTRANET_ROSTER_SYNC: only the word `false` (any case, spaces
 * trimmed) turns the daily sync off; unset, blank or anything else keeps it.
 */
export function isRosterSyncSwitchOn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false";
}

/** Whether the daily sync should run now (read on every call). */
export function isRosterSyncScheduleEnabled(): boolean {
  return (
    isRosterSyncSwitchOn(process.env.NUXT_INTRANET_ROSTER_SYNC) &&
    getIntranetApiBaseUrl() !== null
  );
}

/**
 * One scheduled run. Re-checks the configuration (skips with null when it
 * is off). A refused large deactivation is not a failure: the audit row is
 * already written, a warning is logged and the job completes. Any other
 * error is logged and rethrown so pg-boss retries the job.
 */
export async function runScheduledRosterSync(): Promise<RosterSyncOutcome | null> {
  if (!isRosterSyncScheduleEnabled()) {
    logInfo("members.schedule", { skipped: "disabled" });
    return null;
  }
  try {
    const outcome = await syncIntranetRoster({
      event: null,
      actor: null,
      trigger: "scheduled",
      confirmDeactivation: false,
    });
    if (outcome.status === "blocked") {
      logWarn("members.schedule", {
        reason:
          "large deactivation not applied; run the sync by hand from Miembros to confirm it",
        kinds: outcome.kinds,
      });
    }
    return outcome;
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode: unknown }).statusCode
        : null;
    if (typeof statusCode === "number") {
      // 502 or 503 from syncIntranetRoster, already logged there.
      logWarn("members.schedule", { reason: "sync failed", statusCode });
    } else {
      logError("members.schedule", error);
    }
    throw error;
  }
}

/** pg-boss handler: one run per job (batchSize 1). */
export async function handleRosterSyncJobs(
  jobs: Job<unknown>[],
): Promise<void> {
  for (const job of jobs) {
    logInfo("members.schedule", { run: job.id });
    await runScheduledRosterSync();
  }
}

/**
 * One scheduled access re-check. Skips with null when no authenticated
 * role lookup is configured any more. A blocked run (too many accounts not
 * found) completes: its audit row and error log are written. A run the
 * Intranet cut short throws, so pg-boss retries it later.
 */
export async function runScheduledAccessRecheck(): Promise<AccessRecheckOutcome | null> {
  if (!isAccessRecheckEnabled()) {
    logInfo("access.schedule", { skipped: "disabled" });
    return null;
  }
  const outcome = await recheckIntranetAccess();
  if (outcome.status === "aborted") {
    throw new Error("access re-check aborted: the intranet kept failing");
  }
  return outcome;
}

/** pg-boss handler of the access re-check: one run per job (batchSize 1). */
export async function handleAccessRecheckJobs(
  jobs: Job<unknown>[],
): Promise<void> {
  for (const job of jobs) {
    logInfo("access.schedule", { run: job.id });
    await runScheduledAccessRecheck();
  }
}

/** What the schedule setups need of pg-boss (a stub in tests). */
export type RosterSyncBoss = Pick<
  PgBoss,
  "createQueue" | "schedule" | "unschedule" | "work"
>;

/**
 * Creates the queue (idempotent, on every boot) and, when the daily sync is
 * on, schedules it and starts its worker. When it is off, removes the
 * schedule an earlier boot left in the database: any running pg-boss
 * instance would otherwise keep queueing jobs nobody works.
 */
export async function setupRosterSyncSchedule(
  boss: RosterSyncBoss,
): Promise<"scheduled" | "disabled"> {
  await boss.createQueue(ROSTER_SYNC_QUEUE, {
    retryLimit: ROSTER_SYNC_RETRY_LIMIT,
    retryDelay: ROSTER_SYNC_RETRY_DELAY_SECONDS,
    expireInSeconds: 15 * 60,
    deleteAfterSeconds: 30 * 24 * 3600,
  });

  if (!isRosterSyncScheduleEnabled()) {
    await boss.unschedule(ROSTER_SYNC_QUEUE);
    return "disabled";
  }

  await boss.schedule(ROSTER_SYNC_QUEUE, ROSTER_SYNC_CRON, null, {
    tz: ROSTER_SYNC_TIMEZONE,
    // A server that was down at 05:00 runs it once when it comes back.
    missed: "once",
  });
  await boss.work<unknown>(
    ROSTER_SYNC_QUEUE,
    // A daily job: no need to poll every 2 s.
    { batchSize: 1, pollingIntervalSeconds: 60 },
    handleRosterSyncJobs,
  );
  return "scheduled";
}

/**
 * Same as setupRosterSyncSchedule for the access re-check: creates its
 * queue and, when an authenticated role lookup is configured, schedules it
 * at 05:30 and starts its worker; otherwise removes an earlier schedule.
 */
export async function setupAccessRecheckSchedule(
  boss: RosterSyncBoss,
): Promise<"scheduled" | "disabled"> {
  await boss.createQueue(ACCESS_RECHECK_QUEUE, {
    retryLimit: ACCESS_RECHECK_RETRY_LIMIT,
    retryDelay: ROSTER_SYNC_RETRY_DELAY_SECONDS,
    // One lookup every half second, plus the time the Intranet takes.
    expireInSeconds: 60 * 60,
    deleteAfterSeconds: 30 * 24 * 3600,
  });

  if (!isAccessRecheckEnabled()) {
    await boss.unschedule(ACCESS_RECHECK_QUEUE);
    return "disabled";
  }

  await boss.schedule(ACCESS_RECHECK_QUEUE, ACCESS_RECHECK_CRON, null, {
    tz: ROSTER_SYNC_TIMEZONE,
    missed: "once",
  });
  await boss.work<unknown>(
    ACCESS_RECHECK_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 60 },
    handleAccessRecheckJobs,
  );
  return "scheduled";
}

let starting: Promise<PgBoss | null> | null = null;

/**
 * Starts the pg-boss instance of the daily intranet jobs and sets both up.
 * Never throws: problems are logged. Resolves to null when there is no
 * database, when both jobs are off (the instance is stopped again) or when
 * it could not start. Calling it again returns the same start.
 */
export function startIntranetSchedules(): Promise<PgBoss | null> {
  starting ??= (async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) return null;

    const boss = new PgBoss({
      connectionString,
      schema: PG_BOSS_SCHEMA,
      max: 2,
    });
    boss.on("error", (error) => logError("members.schedule", error));
    try {
      await boss.start({ attempts: SCHEDULE_START_ATTEMPTS });
      const state = await setupRosterSyncSchedule(boss);
      logInfo("members.schedule", {
        state,
        cron: ROSTER_SYNC_CRON,
        timezone: ROSTER_SYNC_TIMEZONE,
      });
      const recheck = await setupAccessRecheckSchedule(boss);
      logInfo("access.schedule", {
        state: recheck,
        cron: ACCESS_RECHECK_CRON,
        timezone: ROSTER_SYNC_TIMEZONE,
      });
      if (state === "disabled" && recheck === "disabled") {
        await boss.stop({ graceful: false });
        return null;
      }
      return boss;
    } catch (error) {
      logError("members.schedule", error);
      await boss.stop({ graceful: false }).catch(() => undefined);
      return null;
    }
  })();
  return starting;
}

/** Stops the instance on shutdown (Nitro's `close` hook). */
export async function stopIntranetSchedules(): Promise<void> {
  const current = starting;
  starting = null;
  const boss = await current;
  await boss?.stop();
}
