import { PgBoss } from "pg-boss";
import { z } from "zod/v4";
import {
  EXPORT_LOCALES,
  EXPORT_VARIANTS,
  type ExportVariant,
} from "../../../shared/utils/schemas/export";

let boss: PgBoss | null = null;
let starting: Promise<PgBoss> | null = null;

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
 * Connections of the queue's own pool. Both workers take one job at a time,
 * and the shared cluster's budget is small (DEPLOYMENT.md).
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

  boss = instance;
  return boss;
}

export function getExportQueueInstance(): PgBoss | null {
  return boss;
}

export const EXPORT_QUEUE_NAMES = {
  ASSEMBLY_EXPORT: "assembly-export",
  DOCUMENT_EXPORT: "document-export",
} as const;

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
});

export const documentExportJobSchema = assemblyExportJobSchema.extend({
  documentId: z.string().min(1),
  variant: z.enum(EXPORT_VARIANTS),
});

export type AssemblyExportJobData = z.infer<typeof assemblyExportJobSchema>;
export type DocumentExportJobData = z.infer<typeof documentExportJobSchema>;
