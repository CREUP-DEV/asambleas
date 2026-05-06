import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createError } from "h3";
import { EXPORT_QUEUE_NAMES, type ExportQueueName } from "./queue";
import {
  PERMISSION_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";

export type ExportStatus = "queued" | "processing" | "done" | "failed";

export interface ExportMetadata {
  jobId: string;
  queueName: ExportQueueName;
  requestedBy: string;
  assemblyId: string;
  documentId?: string;
  locale: "es" | "en";
  status: ExportStatus;
  filename: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

const JOB_ID_PATTERN = /^[a-zA-Z0-9-]{10,120}$/;

export function validateExportJobId(jobId: string | undefined): string {
  if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
    throw createError({ statusCode: 400, message: "Export job ID inválido" });
  }
  return jobId;
}

export function getExportStorageDir() {
  return resolve(process.env.EXPORT_STORAGE_DIR || ".data/exports");
}

export function getExportPdfPath(jobId: string) {
  return join(getExportStorageDir(), `${jobId}.pdf`);
}

function getExportMetadataPath(jobId: string) {
  return join(getExportStorageDir(), `${jobId}.json`);
}

export async function ensureExportStorage() {
  await mkdir(getExportStorageDir(), { recursive: true });
}

export async function writeExportMetadata(metadata: ExportMetadata) {
  await ensureExportStorage();
  const nextMetadata: ExportMetadata = {
    ...metadata,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(
    getExportMetadataPath(metadata.jobId),
    JSON.stringify(nextMetadata, null, 2),
    "utf8",
  );
}

export async function patchExportMetadata(
  jobId: string,
  patch: Partial<Omit<ExportMetadata, "jobId">>,
) {
  const current = await readExportMetadata(jobId);
  await writeExportMetadata({ ...current, ...patch, jobId });
}

export async function readExportMetadata(jobId: string) {
  validateExportJobId(jobId);
  try {
    const raw = await readFile(getExportMetadataPath(jobId), "utf8");
    const parsed = JSON.parse(raw) as ExportMetadata;
    if (
      parsed.queueName !== EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT &&
      parsed.queueName !== EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT
    ) {
      throw new Error("Invalid export queue");
    }
    return parsed;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw createError({
        statusCode: 404,
        message: "Exportación no encontrada",
      });
    }
    throw error;
  }
}

export async function assertExportFileExists(metadata: ExportMetadata) {
  try {
    const fileStat = await stat(metadata.filePath);
    if (!fileStat.isFile()) {
      throw new Error("Export path is not a file");
    }
  } catch {
    throw createError({
      statusCode: 404,
      message: "PDF no disponible. La exportación puede no haber finalizado.",
    });
  }
}

export function getExportPermissionForQueue(
  queueName: ExportQueueName,
): PermissionKey {
  return queueName === EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT
    ? PERMISSION_KEYS.DOCUMENT_MANAGE
    : PERMISSION_KEYS.ASSEMBLY_MANAGE;
}

export function buildExportFilename(parts: string[]) {
  return `${parts
    .join("-")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")}.pdf`;
}

export function getExportMetadataDir(filePath: string) {
  return dirname(filePath);
}

export async function deleteExportMetadata(jobId: string): Promise<void> {
  validateExportJobId(jobId);
  const metadataPath = getExportMetadataPath(jobId);
  await unlink(metadataPath).catch(() => {});
}
