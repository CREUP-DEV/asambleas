import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import type { Job } from "pg-boss";
import type { z } from "zod/v4";
import { logInfo, logWarn, logError } from "../utils/core/logger";
import {
  buildAssemblyExportData,
  buildDocumentExportData,
} from "../utils/export/buildData";
import { loadBrand, loadPdfFonts } from "../utils/export/assets";
import { buildAssemblyPdf, buildDocumentPdf } from "../utils/export/pdfBuilder";
import { PdfRenderLimitError, renderPdf } from "../utils/export/pdfRender";
import {
  DOCUMENT_PAGES_QUEUE_NAME,
  EXPORT_QUEUE_NAMES,
  EXPORT_RETRY_LIMIT,
  PACKAGE_QUEUE_NAME,
  documentPagesJobSchema,
  assemblyExportJobSchema,
  documentExportJobSchema,
  packageJobSchema,
  EXPORT_QUEUE_BOOT_ATTEMPTS,
  getExportQueue,
} from "../utils/export/queue";
import { buildPackage } from "../utils/export/package/build";
import { processDocumentPagesJob } from "../utils/export/documentPages";
import {
  packageBuildEnded,
  packageBuildProgress,
  packageBuildStarted,
  packageKey,
} from "../utils/export/package/service";
import { ExportRejectedError } from "../utils/export/rules";
import {
  getExportMetadataDir,
  patchExportMetadata,
  readExportMetadata,
} from "../utils/export/storage";

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

/**
 * `load` reads the data (buildData.ts: database queries) and answers how to
 * build the definition, which is built here; pdfmake lays it out in the
 * render process (pdfRender.ts), so the app keeps answering meanwhile. The
 * time of each stage is logged on its own.
 */
async function writePdf(
  job: Job<unknown>,
  filePath: string,
  load: () => Promise<() => TDocumentDefinitions>,
) {
  const started = performance.now();
  const build = await load();
  const loadedAt = performance.now();
  const definition = build();
  const builtAt = performance.now();
  const { pdf, maxRssKb, waitedMs } = await renderPdf(
    definition,
    await loadPdfFonts(),
  );
  // Without the wait for the render slot (the other queue's render).
  const renderMs = Math.round(performance.now() - builtAt) - waitedMs;
  await mkdir(getExportMetadataDir(filePath), { recursive: true });
  await writeFile(filePath, pdf);
  await patchExportMetadata(job.id, { status: "done", error: undefined });
  logInfo("export-worker.timing", {
    jobId: job.id,
    queue: job.name,
    buildDataMs: Math.round(loadedAt - started),
    definitionMs: Math.round(builtAt - loadedAt),
    waitMs: waitedMs,
    renderMs,
    maxRssKb,
    bytes: pdf.length,
  });
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
  await writePdf(job, metadata.filePath, async () => {
    const [exportData, letterhead] = await Promise.all([
      buildAssemblyExportData(data),
      loadBrand(),
    ]);
    return () => buildAssemblyPdf(exportData, data.locale, letterhead);
  });
}

async function processDocumentExport(job: Job<unknown>) {
  const data = parseJobData(documentExportJobSchema, job.data);
  const metadata = await readExportMetadataWithRetry(job.id);
  await patchExportMetadata(job.id, { status: "processing", error: undefined });
  await writePdf(job, metadata.filePath, async () => {
    const [exportData, letterhead] = await Promise.all([
      buildDocumentExportData(data),
      loadBrand(),
    ]);
    return () => buildDocumentPdf(exportData, data.locale, letterhead);
  });
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
    // A render that ran out of heap, time or room would do it again.
    const rejected =
      error instanceof ExportRejectedError ||
      error instanceof PdfRenderLimitError;
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

/**
 * Builds a documentation package (package/build.ts). A payload from an
 * older version is dropped; a failed build is retried once by pg-boss, and
 * the endpoints read the progress and the failure from memory.
 */
async function processPackageJob(job: Job<unknown>) {
  const parsed = packageJobSchema.safeParse(job.data);
  if (!parsed.success) {
    logWarn("package.job", { jobId: job.id, reason: "invalid payload" });
    return;
  }
  const data = parsed.data;
  const key = packageKey(data.assemblyId, data.locale, data.editable);
  packageBuildStarted(key);
  try {
    await buildPackage(data, (done, total) =>
      packageBuildProgress(key, done, total),
    );
    packageBuildEnded(key);
  } catch (error) {
    logError("package.job", error, {
      jobId: job.id,
      retryCount: job.retryCount,
    });
    packageBuildEnded(key, { failed: true, retrying: job.retryCount < 1 });
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
    const boss = await getExportQueue({
      attempts: EXPORT_QUEUE_BOOT_ATTEMPTS,
    });

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

    // One package build at a time, whichever assembly: each piece also
    // waits for the render slot like any other export.
    await boss.work<unknown>(
      PACKAGE_QUEUE_NAME,
      { batchSize: 1 },
      async (jobs: Job<unknown>[]) => {
        for (const job of jobs) await processPackageJob(job);
      },
    );

    // The pages of a text the package has not rendered (documentPages.ts),
    // one at a time; each render waits for the render slot. A failure is
    // logged and dropped: the reader asks again later.
    await boss.work<unknown>(
      DOCUMENT_PAGES_QUEUE_NAME,
      { batchSize: 1 },
      async (jobs: Job<unknown>[]) => {
        for (const job of jobs) {
          const parsed = documentPagesJobSchema.safeParse(job.data);
          if (!parsed.success) continue;
          try {
            await processDocumentPagesJob(parsed.data);
          } catch (error) {
            logWarn("document-pages.job", {
              jobId: job.id,
              documentId: parsed.data.documentId,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
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
