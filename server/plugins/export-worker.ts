import { mkdir } from "node:fs/promises";
import * as pdfmakeModule from "pdfmake";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import type { Job } from "pg-boss";
import { logInfo, logWarn, logError } from "../utils/core/logger";
import {
  buildAssemblyExportData,
  buildDocumentExportData,
} from "../utils/export/buildData";
import {
  buildAssemblyPdf,
  buildDocumentPdf,
  type ExportLocale,
} from "../utils/export/pdfBuilder";
import {
  EXPORT_QUEUE_NAMES,
  getExportQueue,
  type AssemblyExportJobData,
  type DocumentExportJobData,
} from "../utils/export/queue";
import {
  getExportMetadataDir,
  patchExportMetadata,
  readExportMetadata,
} from "../utils/export/storage";

type PdfMake = typeof pdfmakeModule;

// pdfmake 0.3 exports a CommonJS singleton whose methods live on its
// prototype, so the namespace object only carries them under `default`.
const pdfmake: PdfMake =
  (pdfmakeModule as unknown as { default?: PdfMake }).default ?? pdfmakeModule;

let fontsReady = false;

async function readServerFont(name: string) {
  const raw = await useStorage("assets:server").getItemRaw(`fonts/${name}`);
  if (!raw) {
    throw new Error(`PDF font asset not found: ${name}`);
  }
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
}

async function ensurePdfFonts() {
  if (fontsReady) return;

  pdfmake.setFonts({
    Raleway: {
      normal: await readServerFont("Raleway-Regular.woff"),
      bold: await readServerFont("Raleway-Bold.woff"),
      italics: await readServerFont("Raleway-Italic.woff"),
      bolditalics: await readServerFont("Raleway-BoldItalic.woff"),
    },
  });
  // Exports never embed remote images or local files by path.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);

  fontsReady = true;
}

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
  throw lastError;
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

async function processAssemblyExport(job: {
  id: string;
  data: AssemblyExportJobData;
}) {
  const metadata = await readExportMetadataWithRetry(job.id);
  await patchExportMetadata(job.id, { status: "processing" });
  const exportData = await buildAssemblyExportData(job.data.assemblyId);
  const docDefinition = buildAssemblyPdf(
    exportData,
    (job.data.locale || metadata.locale) as ExportLocale,
  );
  await writePdf(job.id, metadata.filePath, docDefinition);
}

async function processDocumentExport(job: {
  id: string;
  data: DocumentExportJobData;
}) {
  const metadata = await readExportMetadataWithRetry(job.id);
  await patchExportMetadata(job.id, { status: "processing" });
  const exportData = await buildDocumentExportData(
    job.data.assemblyId,
    job.data.itemId,
    job.data.documentId,
  );
  const docDefinition = buildDocumentPdf(
    exportData,
    (job.data.locale || metadata.locale) as ExportLocale,
  );
  await writePdf(job.id, metadata.filePath, docDefinition);
}

async function processJob<T>(
  job: { id: string; data: T },
  processor: (job: { id: string; data: T }) => Promise<void>,
) {
  try {
    await processor(job);
  } catch (error) {
    try {
      await patchExportMetadata(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown export error",
      });
    } catch {
      logError("export-worker.metadata", error);
    }
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

    await boss.work<AssemblyExportJobData>(
      EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT,
      { batchSize: 1 },
      async (jobs: Job<AssemblyExportJobData>[]) => {
        for (const job of jobs) {
          await processJob(job, processAssemblyExport);
        }
      },
    );

    await boss.work<DocumentExportJobData>(
      EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT,
      { batchSize: 1 },
      async (jobs: Job<DocumentExportJobData>[]) => {
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
