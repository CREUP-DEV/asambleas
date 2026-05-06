import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import PdfPrinter from "pdfmake";
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

let printer: PdfPrinter | null = null;

async function readServerFont(name: string) {
  const raw = await useStorage("assets:server").getItemRaw(`fonts/${name}`);
  if (!raw) {
    throw new Error(`PDF font asset not found: ${name}`);
  }
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
}

async function getPdfPrinter() {
  if (printer) return printer;

  printer = new PdfPrinter({
    Raleway: {
      normal: await readServerFont("Raleway-Regular.woff"),
      bold: await readServerFont("Raleway-Bold.woff"),
      italics: await readServerFont("Raleway-Italic.woff"),
      bolditalics: await readServerFont("Raleway-BoldItalic.woff"),
    },
  });

  return printer;
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
  docDefinition: Parameters<PdfPrinter["createPdfKitDocument"]>[0],
) {
  await mkdir(getExportMetadataDir(filePath), { recursive: true });
  const pdfDoc = (await getPdfPrinter()).createPdfKitDocument(docDefinition);
  const output = createWriteStream(filePath);

  await new Promise<void>((resolve, reject) => {
    pdfDoc.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    pdfDoc.pipe(output);
    pdfDoc.end();
  });

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
      console.error("[export-worker] Failed to update export metadata", error);
    }
    throw error;
  }
}

export default defineNitroPlugin(async () => {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "[export-worker] DATABASE_URL not set, skipping pg-boss setup",
    );
    return;
  }

  try {
    const boss = await getExportQueue();

    await boss.work<AssemblyExportJobData>(
      EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT,
      { batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          await processJob(job, processAssemblyExport);
        }
      },
    );

    await boss.work<DocumentExportJobData>(
      EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT,
      { batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          await processJob(job, processDocumentExport);
        }
      },
    );

    console.log("[export-worker] pg-boss worker started");
  } catch (error) {
    console.error("[export-worker] Failed to start pg-boss worker:", error);
  }
});
