import { sendReadStream } from "../../../utils/core/http";
import { defineEventHandler, getRouterParam, setResponseHeaders } from "h3";
import { createReadStream } from "node:fs";
import { requireActor } from "../../../utils/domain/actor";
import { resolveAvatarFile } from "../../../utils/auth/avatarRoute";

/**
 * An account's stored photo (user_avatars), to any signed-in account with
 * access: avatars show in menus, lists and the statistics. Only a file a
 * row names now is served. Its name carries the picture's version, so the
 * browser may keep it for good; a new picture is a new name.
 */
export default defineEventHandler(async (event) => {
  await requireActor(event);
  const path = await resolveAvatarFile(getRouterParam(event, "file"));
  setResponseHeaders(event, {
    "Content-Type": "image/webp",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  });
  return sendReadStream(event, createReadStream(path));
});
