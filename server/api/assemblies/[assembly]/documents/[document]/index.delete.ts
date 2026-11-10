import { defineEventHandler } from "h3";
import {
  deleteDocument,
  resolveDocumentRoute,
} from "../../../../../utils/domain/documents";
import { removeImageFiles } from "../../../../../utils/domain/documentImages";

export default defineEventHandler(async (event): Promise<{ success: true }> => {
  const ctx = await resolveDocumentRoute(event);
  // Its images' rows go with it (cascade); their files once it is gone.
  const { images } = await deleteDocument(ctx);
  await removeImageFiles(images);
  return { success: true };
});
