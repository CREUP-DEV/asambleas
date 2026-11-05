import { defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActor } from "../../../utils/domain/actor";
import { parseDocumentBody } from "../../../utils/domain/documents";
import { resolveAssembly } from "../../../utils/domain/resolvers";
import { enqueueExport } from "../../../utils/export/enqueue";
import { EXPORT_QUEUE_NAMES } from "../../../utils/export/queue";
import { formatAssemblyLabel } from "~~/shared/utils/slug";
import { assemblyExportSchema } from "~~/shared/utils/schemas/export";

/**
 * Queues the assembly dossier: cover, agenda and every published document.
 * It only carries published content, so anyone who can see the assembly
 * may request it. The request is recorded as `export.request` (enqueueExport).
 */
export default defineEventHandler(async (event): Promise<{ jobId: string }> => {
  const actor = await requireActor(event);
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
