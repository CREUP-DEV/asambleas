import { PgBoss, type WipData } from "pg-boss";
import { z } from "zod/v4";
import { logError } from "../core/logger";
import {
  EXPORT_LOCALES,
  EXPORT_VARIANTS,
  type ExportVariant,
} from "../../../shared/utils/schemas/export";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

type ExportQueueStarter = (instance: PgBoss) => Promise<void>;
const starters: { name: string; start: ExportQueueStarter }[] = [];

/**
 * Runs `start` (registering workers) on the instance whoever starts it: the
 * worker plugin's boot start, or, when that gave up, the first request that
 * starts the instance later. Registered before the instance exists, it runs
 * inside the start, before any caller gets the instance; registered after,
 * it runs at once. A starter that fails is logged and the others still run:
 * the instance stays up, and /api/health calls it stalled.
 */
export function onExportQueueStart(
  name: string,
  start: ExportQueueStarter,
): void {
  starters.push({ name, start });
  if (boss) void runStarter(boss, { name, start });
}

async function runStarter(
  instance: PgBoss,
  starter: { name: string; start: ExportQueueStarter },
): Promise<void> {
  try {
    await starter.start(instance);
  } catch (error) {
    logError("export.queue", error, { action: "start", starter: starter.name });
  }
}

/** Attempts after the first one. Deterministic failures are never retried. */
export const EXPORT_RETRY_LIMIT = 2;

/**
 * Start attempts at boot. After a host reboot the app can come up before the
 * shared PostgreSQL accepts connections; pg-boss waits 1, 2, 4... up to 30 s
 * between attempts, so 20 cover about 7 minutes instead of giving up at once
 * and leaving the export worker unregistered until the next restart.
 */
export const EXPORT_QUEUE_BOOT_ATTEMPTS = 20;

/**
 * Connections of the instance's own pool. Besides the exports it runs the
 * package, the pages of a text, the account and room photos and the images'
 * clean-up, each worker one job at a time; the shared cluster's budget is
 * small (DEPLOYMENT.md).
 */
const EXPORT_QUEUE_MAX_CONNECTIONS = 3;

/**
 * The started queue. Concurrent callers share one start, so a request that
 * arrives while the boot start is still retrying waits for it instead of
 * opening a second instance.
 */
export function getExportQueue(
  options: { attempts?: number } = {},
): Promise<PgBoss> {
  if (boss) return Promise.resolve(boss);
  starting ??= startExportQueue(options.attempts ?? 1).finally(() => {
    starting = null;
  });
  return starting;
}

async function startExportQueue(attempts: number): Promise<PgBoss> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for pg-boss queue");
  }

  const instance = new PgBoss({
    connectionString: databaseUrl,
    schema: "pgboss",
    max: EXPORT_QUEUE_MAX_CONNECTIONS,
  });
  // A failed fetch (PostgreSQL restarting) is emitted as "error": with no
  // listener the emit throws out of the worker's loop and that worker stops
  // for good while the process lives on. Listened to, the worker logs it and
  // polls again.
  instance.on("error", (error) => logError("export.queue", error));

  await instance.start({ attempts });

  // pg-boss >= 10 rejects send() and work() on a queue that was never created.
  // createQueue is idempotent, so running it on every boot is safe.
  for (const name of Object.values(EXPORT_QUEUE_NAMES)) {
    await instance.createQueue(name, {
      retryLimit: EXPORT_RETRY_LIMIT,
      retryDelay: 5,
      expireInSeconds: 3600,
      deleteAfterSeconds: 7 * 24 * 3600,
    });
  }
  // One package build per assembly, language and variant running and one
  // waiting (its singletonKey): asking again while one waits adds nothing,
  // and the waiting one builds the latest state when its turn comes.
  await instance.createQueue(PACKAGE_QUEUE_NAME, {
    policy: "stately",
    retryLimit: 1,
    retryDelay: 30,
    expireInSeconds: 3600,
    deleteAfterSeconds: 24 * 3600,
  });

  // The pages of a text the package has not rendered (documentPages.ts):
  // one job per version and layout waiting at a time, not retried (the
  // reader asks again later).
  await instance.createQueue(DOCUMENT_PAGES_QUEUE_NAME, {
    policy: "stately",
    retryLimit: 0,
    expireInSeconds: 900,
    deleteAfterSeconds: 24 * 3600,
  });

  // The workers, before any caller gets the instance (onExportQueueStart).
  for (const starter of starters) await runStarter(instance, starter);

  boss = instance;
  return boss;
}

export function getExportQueueInstance(): PgBoss | null {
  return boss;
}

/** Forgets the instance and the starters (tests only). */
export function resetExportQueueForTests(): void {
  boss = null;
  starting = null;
  starters.length = 0;
}

/**
 * How long an idle worker may go without a successful fetch before the
 * health check calls the queue stalled. Workers poll every 2 s, every 30 s
 * at most when NOTIFY wakes them.
 */
export const EXPORT_WORKER_STALL_MS = 5 * 60_000;

/**
 * Whether the export instance's workers have stopped working: the document
 * export or the package has no worker (the worker plugin failed to start and
 * a request created the instance without them), or an idle worker has not
 * fetched for `stallMs` (a database that stays unreachable). A worker busy
 * with a job is not judged: a package build takes minutes.
 */
export function exportWorkersStalled(
  workers: readonly Pick<
    WipData,
    "name" | "count" | "createdOn" | "lastFetchedOn"
  >[],
  now: number,
  stallMs: number = EXPORT_WORKER_STALL_MS,
): boolean {
  const required = [EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT, PACKAGE_QUEUE_NAME];
  if (required.some((name) => !workers.some((w) => w.name === name))) {
    return true;
  }
  return workers.some(
    (worker) =>
      worker.count === 0 &&
      now - (worker.lastFetchedOn ?? worker.createdOn) > stallMs,
  );
}

/** The export queue's state, for /api/health to report as `checks.queue`. */
export function exportQueueHealth(
  now: number = Date.now(),
): "unavailable" | "stalled" | "ok" {
  if (!boss) return "unavailable";
  return exportWorkersStalled(boss.getWipData(), now) ? "stalled" : "ok";
}

export const EXPORT_QUEUE_NAMES = {
  ASSEMBLY_EXPORT: "assembly-export",
  DOCUMENT_EXPORT: "document-export",
} as const;

/** The documentation package of an assembly (package/build.ts). */
export const PACKAGE_QUEUE_NAME = "assembly-package";

export type ExportQueueName =
  (typeof EXPORT_QUEUE_NAMES)[keyof typeof EXPORT_QUEUE_NAMES];

export { EXPORT_VARIANTS, type ExportVariant };

/**
 * Job payloads are validated again in the worker, so jobs queued by an
 * older version of the app fail cleanly instead of rendering garbage.
 */
export const assemblyExportJobSchema = z.object({
  assemblyId: z.string().min(1),
  /** The effective user (the account acted as, while impersonating): it owns the job. */
  requestedBy: z.string().min(1),
  /**
   * The impersonation the request ran under, for the audit trail. Optional,
   * so jobs queued before it existed still parse.
   */
  impersonationId: z.string().min(1).nullish(),
  locale: z.enum(EXPORT_LOCALES),
  /** Justified text (the reader's preference); jobs from before read true. */
  justified: z.boolean().default(true),
});

export const documentExportJobSchema = assemblyExportJobSchema.extend({
  documentId: z.string().min(1),
  variant: z.enum(EXPORT_VARIANTS),
});

export type AssemblyExportJobData = z.infer<typeof assemblyExportJobSchema>;
export type DocumentExportJobData = z.infer<typeof documentExportJobSchema>;

export const packageJobSchema = z.object({
  assemblyId: z.string().min(1),
  locale: z.enum(EXPORT_LOCALES),
  editable: z.boolean(),
  /** Justified text; jobs from before read true. */
  justified: z.boolean().default(true),
});

export type PackageJobData = z.infer<typeof packageJobSchema>;

/** Where the pages of a text's clean PDF start (documentPages.ts). */
export const DOCUMENT_PAGES_QUEUE_NAME = "document-pages";

export const documentPagesJobSchema = z.object({
  documentId: z.string().min(1),
  version: z.enum(["base", "consolidated"]),
});

export type DocumentPagesJobData = z.infer<typeof documentPagesJobSchema>;
