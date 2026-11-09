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
import { assemblies, documentImages, documents } from "../../../db/schema";
import { IMAGE_ASSET_PATTERN } from "~~/shared/types/content";
import { requireActor } from "../../../utils/domain/actor";
import {
  getImageDir,
  imageFileName,
} from "../../../utils/domain/documentImages";
import { withCoProponentIds } from "../../../utils/domain/presenters";
import {
  canSeeAssembly,
  canSeeDocument,
} from "../../../utils/domain/visibility";

function notFound(): never {
  throw createError({ statusCode: 404, message: "Imagen no encontrada" });
}

/**
 * Serves an image of a document's text to whoever can see that document,
 * as PDFs are served: an image of a draft only to those who see the draft.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);

  const id = getRouterParam(event, "image");
  if (!id || !IMAGE_ASSET_PATTERN.test(id)) notFound();

  const [row] = await db
    .select({
      mimeType: documentImages.mimeType,
      id: documents.id,
      status: documents.status,
      format: documents.format,
      proponentMemberId: documents.proponentMemberId,
      submittedByUserId: documents.submittedByUserId,
      assemblyStatus: assemblies.status,
    })
    .from(documentImages)
    .innerJoin(documents, eq(documents.id, documentImages.documentId))
    .innerJoin(assemblies, eq(assemblies.id, documents.assemblyId))
    .where(eq(documentImages.id, id))
    .limit(1);

  if (
    !row ||
    !canSeeAssembly(actor, { status: row.assemblyStatus }) ||
    // Co-presenters see a draft like its main presenter.
    !canSeeDocument(actor, (await withCoProponentIds([row]))[0]!)
  ) {
    notFound();
  }

  const name = imageFileName(id, row.mimeType);
  if (!name) notFound();
  const path = join(getImageDir(), name);
  try {
    if (!(await stat(path)).isFile()) notFound();
  } catch {
    notFound();
  }

  setResponseHeaders(event, {
    "Content-Type": row.mimeType,
    // An image never changes under its id; who may see it can.
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  });
  return sendStream(event, createReadStream(path));
});
