import { defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActor, requireCan } from "../../../utils/domain/actor";
import { parseDocumentBody } from "../../../utils/domain/documents";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { enqueueExport } from "../../../utils/export/enqueue";
import { EXPORT_QUEUE_NAMES } from "../../../utils/export/queue";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import { formatAssemblyLabel } from "~~/shared/utils/slug";
import { assemblyExportSchema } from "~~/shared/utils/schemas/export";

/**
 * Queues the assembly dossier: cover, agenda and every published document.
 * It only carries published content, but laying out every text of an
 * assembly takes the longest of any export, so only those who manage
 * assemblies (assembly:manage) ask for it; no screen offers it to anyone
 * else. The request is recorded as `export.request` (enqueueExport).
 */
export default defineEventHandler(async (event): Promise<{ jobId: string }> => {
  const actor = await requireActor(event);
  requireCan(actor, PERMISSION_KEYS.ASSEMBLY_MANAGE);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
  const body = parseDocumentBody(
    assemblyExportSchema,
    (await readBody(event)) ?? {},
  );

  return enqueueExport({
    queueName: EXPORT_QUEUE_NAMES.ASSEMBLY_EXPORT,
    data: {
      assemblyId: assembly.id,
      requestedBy: actor.user.id,
      locale: body.locale,
    },
    filenameParts: [formatAssemblyLabel(assembly)],
    event,
    actor,
  });
});
