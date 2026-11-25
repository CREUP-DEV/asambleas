import { readBodyWith } from "../../../utils/core/http";
import { defineEventHandler } from "h3";
import { requireCan } from "../../../utils/domain/actor";
import { enqueueExport } from "../../../utils/export/enqueue";
import { EXPORT_QUEUE_NAMES } from "../../../utils/export/queue";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { formatAssemblyLabel } from "~~/shared/utils/slug";
import { assemblyExportSchema } from "~~/shared/utils/schemas/export";
import { resolveAssemblyRoute } from "../../../utils/domain/assemblyRoute";

/**
 * Queues the assembly dossier: cover, agenda and every published document.
 * It only carries published content, but laying out every text of an
 * assembly takes the longest of any export, so only those who manage
 * assemblies (assembly:manage) ask for it; no screen offers it to anyone
 * else. The request is recorded as `export.request` (enqueueExport).
 */
export default defineEventHandler(async (event): Promise<{ jobId: string }> => {
  const { actor, assembly } = await resolveAssemblyRoute(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const body = await readBodyWith(event, assemblyExportSchema, { empty: {} });

  return enqueueExport({
    queueName: EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT,
    data: {
      assemblyId: assembly.id,
      requestedBy: actor.user.id,
      locale: body.locale,
      justified: body.justified,
    },
    filenameParts: [formatAssemblyLabel(assembly)],
    event,
    actor,
  });
});
