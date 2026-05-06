import { defineEventHandler, createError, readMultipartFormData } from "h3";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { requirePermission } from "../../utils/auth/rbac";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { getUploadDir } from "../../utils/core/uploadPaths";

const ALLOWED_MIME_TYPES = ["application/pdf"];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.DOCUMENT_MANAGE);

  const parts = await readMultipartFormData(event);
  if (!parts || parts.length === 0) {
    throw createError({
      statusCode: 400,
      message: "No se recibió ningún archivo",
    });
  }

  const filePart = parts.find((p) => p.name === "file");
  if (!filePart || !filePart.data) {
    throw createError({ statusCode: 400, message: "Campo 'file' requerido" });
  }

  if (filePart.data.length > MAX_FILE_SIZE_BYTES) {
    throw createError({
      statusCode: 413,
      message: "El archivo supera el límite de 20MB",
    });
  }

  const mimeType = filePart.type ?? "";
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw createError({
      statusCode: 415,
      message: "Solo se admiten archivos PDF",
    });
  }

  const signature = filePart.data.subarray(0, 5).toString("ascii");
  if (signature !== "%PDF-") {
    throw createError({
      statusCode: 415,
      message: "El archivo no parece ser un PDF válido",
    });
  }

  const storedName = `${randomUUID()}.pdf`;
  const uploadPath = getUploadDir();

  await mkdir(uploadPath, { recursive: true });
  await writeFile(join(uploadPath, storedName), filePart.data);

  return { fileUrl: `/api/uploads/documents/${storedName}` };
});
