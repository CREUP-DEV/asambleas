import { notFound } from "../core/http";
import { eq } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { db } from "../../db";
import { userAvatars } from "../../db/schema";
import { avatarPath, parseAvatarFileName } from "./avatarFiles";

const NOT_FOUND_MESSAGE = "Imagen no encontrada";

/**
 * The path of a stored photo GET /api/uploads/avatars/[file] may serve:
 * a valid name that its account's row names now and that is on disk. 404
 * for anything else (a photo replaced or dropped, a name that is not one).
 */
export async function resolveAvatarFile(
  name: string | null | undefined,
): Promise<string> {
  if (!name) notFound(NOT_FOUND_MESSAGE);
  const parsed = parseAvatarFileName(name);
  if (!parsed) notFound(NOT_FOUND_MESSAGE);
  const [row] = await db
    .select({ file: userAvatars.file })
    .from(userAvatars)
    .where(eq(userAvatars.userId, parsed.userId))
    .limit(1);
  if (!row || row.file !== name) notFound(NOT_FOUND_MESSAGE);
  const path = avatarPath(name);
  if (!path) notFound(NOT_FOUND_MESSAGE);
  try {
    if (!(await stat(path)).isFile()) notFound(NOT_FOUND_MESSAGE);
  } catch {
    notFound(NOT_FOUND_MESSAGE);
  }
  return path;
}
