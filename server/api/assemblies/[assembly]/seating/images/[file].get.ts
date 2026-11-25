import { sendReadStream } from "../../../../../utils/core/http";
import { defineEventHandler, getRouterParam, setResponseHeaders } from "h3";
import { createReadStream } from "node:fs";
import {
  requireSeatingReader,
  resolveSeatingImage,
} from "../../../../../utils/domain/seating";
import { resolveAssemblyRoute } from "../../../../../utils/domain/assemblyRoute";

/**
 * A cached logo or photo of the room (seating:view or seating:edit), never
 * as the room. Its name carries the Intranet's version, so the browser may
 * keep it for good; a new version is a new name.
 */
export default defineEventHandler(async (event) => {
  const { actor, assembly } = await resolveAssemblyRoute(event, {
    viewer: true,
  });
  requireSeatingReader(actor);
  const path = await resolveSeatingImage(
    actor,
    assembly,
    getRouterParam(event, "file"),
  );
  setResponseHeaders(event, {
    "Content-Type": "image/webp",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  });
  return sendReadStream(event, createReadStream(path));
});
