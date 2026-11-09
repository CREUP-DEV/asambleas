import { defineEventHandler } from "h3";
import { eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { documentImages } from "../../../../../db/schema";
import {
  deleteDocument,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { removeImageFiles } from "../../../../../utils/domain/documentImages";

export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const ctx = await resolveDocumentRoute(event);
  // Its images' rows go with it (cascade); their files once it is gone.
  const images = await db
    .select({ id: documentImages.id, mimeType: documentImages.mimeType })
    .from(documentImages)
    .where(eq(documentImages.documentId, ctx.document.id));
  const result = await deleteDocument(ctx);
  await removeImageFiles(images);
  return result;
});
