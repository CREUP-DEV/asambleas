import { join, resolve } from "node:path";

export function getUploadDir(): string {
  return resolve(
    process.env.UPLOAD_STORAGE_DIR ??
      join(process.cwd(), "private/uploads/documents"),
  );
}
