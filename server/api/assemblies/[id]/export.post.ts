import { defineEventHandler, createError, readBody } from "h3";
import { randomUUID } from "node:crypto";
import { requirePermission } from "../../../utils/auth/rbac";
import { getAuthUserWithRole } from "../../../utils/auth/requireAuth";
import { resolveAssemblyFromParam } from "../../../utils/routeResolvers";
import {
  EXPORT_QUEUE_NAMES,
  getExportQueue,
} from "../../../utils/export/queue";
import {
  buildExportFilename,
  deleteExportMetadata,
  getExportPdfPath,
  writeExportMetadata,
} from "../../../utils/export/storage";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { formatAssemblyLabel } from "~~/shared/utils/slug";
import { createExportSchema } from "~~/shared/utils/schemas/export";

export default defineEventHandler(async (event) => {
  await requirePermission(event, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const user = await getAuthUserWithRole(event);
  const body = await readBody(event);
  const parsed = createExportSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Datos inválidos" });
  }

  const assembly = await resolveAssemblyFromParam(event.context.params?.id);

  try {
    const boss = await getExportQueue();
    const jobId = randomUUID();

    await writeExportMetadata({
      jobId,
      queueName: EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT,
      requestedBy: user!.id,
      assemblyId: assembly.id,
      locale: parsed.data.locale,
      status: "queued",
      filename: buildExportFilename([formatAssemblyLabel(assembly)]),
      filePath: getExportPdfPath(jobId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    try {
      const queuedJobId = await boss.send(
        EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT,
        {
          assemblyId: assembly.id,
          requestedBy: user!.id,
          locale: parsed.data.locale,
        },
        { id: jobId },
      );
      if (queuedJobId) {
        return { jobId };
      }
    } catch {
      await deleteExportMetadata(jobId);
      throw new Error("pg-boss failed to queue export job");
    }

    await deleteExportMetadata(jobId);
    throw new Error("pg-boss did not return a job id");
  } catch {
    throw createError({
      statusCode: 500,
      message: "No se pudo iniciar la exportación",
    });
  }
});
