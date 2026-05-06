import {
  createError,
  defineEventHandler,
  getRouterParam,
  sendStream,
  setResponseHeaders,
} from "h3";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../../db";
import { documents } from "../../../db/schema";
import {
  getAuthUserWithRole,
  requireAuth,
} from "../../../utils/auth/requireAuth";
import { isAdmin } from "../../../utils/auth/rbac";
import { getUploadDir } from "../../../utils/core/uploadPaths";
import { SYSTEM_ROLES } from "~~/shared/constants/roles";
import {
  ASSEMBLY_STATUSES,
  DOCUMENT_STATUSES,
} from "~~/shared/constants/statuses";

const UUID_V4_PDF =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.pdf$/;

export default defineEventHandler(async (event) => {
  await requireAuth(event);
  const user = await getAuthUserWithRole(event);

  const filename = getRouterParam(event, "filename");
  if (!filename || !UUID_V4_PDF.test(filename)) {
    throw createError({ statusCode: 400, message: "Archivo no válido" });
  }

  const fileUrl = `/api/uploads/documents/${filename}`;

  const doc = await db.query.documents.findFirst({
    where: eq(documents.fileUrl, fileUrl),
    columns: {
      id: true,
      status: true,
      submittedBy: true,
      fileUrl: true,
      type: true,
    },
    with: {
      agendaItem: {
        columns: { id: true, assemblyId: true },
        with: {
          assembly: {
            columns: { id: true, status: true },
          },
        },
      },
    },
  });

  if (!doc || doc.type !== "pdf" || !doc.fileUrl) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  const assembly = doc.agendaItem.assembly;

  const canSeeDrafts =
    isAdmin(user?.role?.name) || user?.role?.name === SYSTEM_ROLES.SECRETARIA;

  if (assembly.status === ASSEMBLY_STATUSES.DRAFT && !canSeeDrafts) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  const canSeeDocument =
    doc.status === DOCUMENT_STATUSES.ACCEPTED ||
    canSeeDrafts ||
    (doc.submittedBy !== null && doc.submittedBy === user?.id);

  if (!canSeeDocument) {
    throw createError({ statusCode: 404, message: "Documento no encontrado" });
  }

  const filePath = join(getUploadDir(), filename);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error("Upload path is not a file");
    }
  } catch {
    throw createError({ statusCode: 404, message: "Archivo no encontrado" });
  }

  setResponseHeaders(event, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${filename}"`,
  });

  return sendStream(event, createReadStream(filePath));
});
