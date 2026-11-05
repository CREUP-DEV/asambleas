import { createError, defineEventHandler, readBody } from "h3";
import {
  parseDocumentBody,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { enqueueExport } from "../../../../../utils/export/enqueue";
import { createTranslator } from "../../../../../utils/export/labels";
import { EXPORT_QUEUE_NAMES } from "../../../../../utils/export/queue";
import {
  EXPORT_REFUSAL_MESSAGES,
  EXPORT_REFUSAL_STATUS,
  exportRefusal,
} from "../../../../../utils/export/rules";
import { formatAssemblyLabel } from "~~/shared/utils/slug";
import { documentExportSchema } from "~~/shared/utils/schemas/export";

/**
 * Queues a clean or annotated PDF of a visible document. The worker checks
 * visibility again when it renders, with the data as it is then. The
 * request is recorded as `export.request` (enqueueExport).
 */
export default defineEventHandler(async (event): Promise<{ jobId: string }> => {
  const { actor, assembly, document } = await resolveDocumentRoute(event);
  const body = parseDocumentBody(
    documentExportSchema,
    (await readBody(event)) ?? {},
  );

  const refusal = exportRefusal(actor, document, body.variant);
  if (refusal) {
    throw createError({
      statusCode: EXPORT_REFUSAL_STATUS[refusal],
      message: EXPORT_REFUSAL_MESSAGES[refusal],
    });
  }

  const t = createTranslator(body.locale);
  return enqueueExport({
    queueName: EXPORT_QUEUE_NAMES.DOCUMENT_EXPORT,
    data: {
      assemblyId: assembly.id,
      documentId: document.id,
      requestedBy: actor.user.id,
      locale: body.locale,
      variant: body.variant,
    },
    filenameParts: [
      formatAssemblyLabel(assembly),
      document.reference ?? document.slug,
      body.variant === "annotated" ? t("filename.annotated") : "",
    ],
    event,
    actor,
  });
});
