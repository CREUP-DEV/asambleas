import { PgBoss } from "pg-boss";

let boss: PgBoss | null = null;

export async function getExportQueue(): Promise<PgBoss> {
  if (boss) return boss;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for pg-boss queue");
  }

  const instance = new PgBoss({
    connectionString: databaseUrl,
    schema: "pgboss",
  });

  await instance.start();

  // pg-boss >= 10 rejects send() and work() on a queue that was never created.
  // createQueue is idempotent, so running it on every boot is safe.
  for (const name of Object.values(EXPORT_QUEUE_NAMES)) {
    await instance.createQueue(name, {
      retryLimit: 2,
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

export interface AssemblyExportJobData {
  assemblyId: string;
  requestedBy: string;
  locale: "es" | "en";
}

export interface DocumentExportJobData {
  assemblyId: string;
  itemId: string;
  documentId: string;
  requestedBy: string;
  locale: "es" | "en";
}
