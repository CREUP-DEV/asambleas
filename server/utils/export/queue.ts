import PgBoss from "pg-boss";

let boss: PgBoss | null = null;

export async function getExportQueue(): Promise<PgBoss> {
  if (boss) return boss;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for pg-boss queue");
  }

  boss = new PgBoss({
    connectionString: databaseUrl,
    schema: "pgboss",
    retryLimit: 2,
    retryDelay: 5,
    expireInHours: 1,
    archiveCompletedAfterSeconds: 3600,
    deleteAfterDays: 7,
  });

  await boss.start();
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
