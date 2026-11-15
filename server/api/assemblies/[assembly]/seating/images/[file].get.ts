import {
  defineEventHandler,
  getRouterParam,
  sendStream,
  setResponseHeaders,
} from "h3";
import { createReadStream } from "node:fs";
import { resolveAssembly } from "../../../../../utils/domain/resolvers";
import { requireViewer } from "../../../../../utils/domain/roomView";
import {
  requireSeatingReader,
  resolveSeatingImage,
} from "../../../../../utils/domain/seating";

/**
 * A cached logo or photo of the room (seating:view or seating:edit), never
 * as the room. Its name carries the Intranet's version, so the browser may
 * keep it for good; a new version is a new name.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireViewer(event);
  requireSeatingReader(actor);
  const assembly = await resolveAssembly(
    actor,
    getRouterParam(event, "assembly"),
  );
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
  return sendStream(event, createReadStream(path));
});
