import { mkdir } from "node:fs/promises";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import type { Job } from "pg-boss";
import type { z } from "zod/v4";
import { logInfo, logWarn, logError } from "../utils/core/logger";
import {
  buildAssemblyExportData,
  buildDocumentExportData,
} from "../utils/export/buildData";
import { buildAssemblyPdf, buildDocumentPdf } from "../utils/export/pdfBuilder";
import {
  RALEWAY_FILES,
  pdfmake,
  registerPdfFonts,
  type RalewayFile,
} from "../utils/export/pdfmake";
import {
  EXPORT_QUEUE_NAMES,
  EXPORT_RETRY_LIMIT,
  assemblyExportJobSchema,
  documentExportJobSchema,
  getExportQueue,
} from "../utils/export/queue";
import { ExportRejectedError } from "../utils/export/rules";
import {
  getExportMetadataDir,
  patchExportMetadata,
  readExportMetadata,
} from "../utils/export/storage";

let fontsReady = false;

async function readServerFont(name: RalewayFile): Promise<Buffer> {
  const raw = await useStorage("assets:server").getItemRaw(`fonts/${name}`);
  if (!raw) {
    throw new Error(`PDF font asset not found: ${name}`);
  }
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
}

async function ensurePdfFonts() {
  if (fontsReady) return;
  const names = Object.values(RALEWAY_FILES);
  const buffers = await Promise.all(names.map(readServerFont));
  registerPdfFonts(
    Object.fromEntries(names.map((name, i) => [name, buffers[i]!])) as Record<
      RalewayFile,
      Buffer
    >,
  );
  fontsReady = true;
}

/** Metadata is written before the job is queued; without it the job is void. */
async function readExportMetadataWithRetry(jobId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await readExportMetadata(jobId);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  logError("export-worker.metadata", lastError, { jobId });
  throw new ExportRejectedError("Export metadata missing or unreadable");
}

async function writePdf(
  jobId: string,
  filePath: string,
  docDefinition: TDocumentDefinitions,
) {
  await mkdir(getExportMetadataDir(filePath), { recursive: true });
  await ensurePdfFonts();
  await pdfmake.createPdf(docDefinition).write(filePath);

  await patchExportMetadata(jobId, { status: "done", error: undefined });
}

/** Job payloads queued by an older version of the app fail without retry. */
function parseJobData<S extends z.ZodType>(
  schema: S,
  data: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ExportRejectedError("Invalid export job payload");
  return parsed.data;
}

async function processAssemblyExport(job: Job<unknown>) {
  const data = parseJobData(assemblyExportJobSchema, job.data);
  const metadata = await readExportMetadataWithRetry(job.id);
  await patchExportMetadata(job.id, { status: "processing", error: undefined });
  const exportData = await buildAssemblyExportData(data);
  await writePdf(
    job.id,
    metadata.filePath,
    buildAssemblyPdf(exportData, data.locale),
  );
}

async function processDocumentExport(job: Job<unknown>) {
  const data = parseJobData(documentExportJobSchema, job.data);
  const metadata = await readExportMetadataWithRetry(job.id);
  await patchExportMetadata(job.id, { status: "processing", error: undefined });
  const exportData = await buildDocumentExportData(data);
  await writePdf(
    job.id,
    metadata.filePath,
    buildDocumentPdf(exportData, data.locale),
  );
}

/**
 * A rejected export (the requester can no longer export it) is marked
 * failed and completes, so pg-boss does not retry it. Other errors are
 * retried: the metadata goes back to queued, so clients keep polling, and
 * only the last attempt marks it failed.
 */
async function processJob(
  job: Job<unknown>,
  processor: (job: Job<unknown>) => Promise<void>,
) {
  try {
    await processor(job);
  } catch (error) {
    const rejected = error instanceof ExportRejectedError;
    const final = rejected || job.retryCount >= EXPORT_RETRY_LIMIT;
    const message =
      error instanceof Error ? error.message : "Unknown export error";
    try {
      await patchExportMetadata(job.id, {
        status: final ? "failed" : "queued",
        error: message,
      });
    } catch (metadataError) {
      logError("export-worker.metadata", metadataError);
    }
    if (rejected) {
      logWarn("export-worker.rejected", { jobId: job.id, reason: message });
      return;
    }
    logError("export-worker.job", error, {
      jobId: job.id,
      retryCount: job.retryCount,
    });
    throw error;
  }
}

export default defineNitroPlugin(async (nitroApp) => {
  if (!process.env.DATABASE_URL) {
    logWarn("export-worker.init", {
      reason: "DATABASE_URL not set, skipping pg-boss setup",
    });
    return;
  }

  try {
    const boss = await getExportQueue();

    await boss.work<unknown>(
      EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT,
      { batchSize: 1 },
      async (jobs: Job<unknown>[]) => {
        for (const job of jobs) {
          await processJob(job, processAssemblyExport);
        }
      },
    );

    await boss.work<unknown>(
      EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT,
      { batchSize: 1 },
      async (jobs: Job<unknown>[]) => {
        for (const job of jobs) {
          await processJob(job, processDocumentExport);
        }
      },
    );

    nitroApp.hooks.hook("close", async () => {
      logInfo("export-worker.shutdown", {});
      await boss.stop();
    });

    logInfo("export-worker.init", { message: "pg-boss worker started" });
  } catch (error) {
    logError("export-worker.init", error);
  }
});
