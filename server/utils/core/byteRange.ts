import { createReadStream } from "node:fs";
import {
  getRequestHeader,
  sendNoContent,
  sendStream,
  setResponseHeader,
  setResponseHeaders,
  setResponseStatus,
  type H3Event,
} from "h3";

/**
 * One `Range: bytes=…` request against a stored file (RFC 9110 §14), as the
 * PDF endpoints answer it: pdf.js asks for the parts of a long PDF it needs
 * instead of waiting for the whole file. Only a single range is served; a
 * list of ranges, another unit or a malformed header is ignored and the
 * whole file goes out, which the RFC allows. An `If-Range` that does not
 * name the file's current ETag (strong comparison; a date never matches,
 * since no Last-Modified is sent) also sends the whole file.
 */
export type ByteRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/i;

export function resolveByteRange(
  header: string | null | undefined,
  size: number,
  ifRange: string | null | undefined,
  etag: string,
): ByteRange {
  if (!header) return { kind: "full" };
  if (ifRange !== undefined && ifRange !== null && ifRange.trim() !== etag) {
    return { kind: "full" };
  }
  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) return { kind: "full" };
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return { kind: "full" };

  if (first === "") {
    // A suffix: the last N bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return { kind: "unsatisfiable" };
    return {
      kind: "partial",
      start: Math.max(0, size - length),
      end: size - 1,
    };
  }

  const start = Number(first);
  // A last byte before the first makes the header invalid: ignored.
  if (last !== "" && Number(last) < start) return { kind: "full" };
  if (start >= size) return { kind: "unsatisfiable" };
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return { kind: "partial", start, end };
}

/**
 * Sends a stored file after the handler's checks and its 304: the part a
 * `Range` asks for (206), a 416 when it starts past the end, else the whole
 * file, each with its `Content-Length`. The handler sets `Accept-Ranges`
 * with its other headers.
 */
export function sendFileRange(
  event: H3Event,
  filePath: string,
  size: number,
  etag: string,
) {
  const range = resolveByteRange(
    getRequestHeader(event, "range"),
    size,
    getRequestHeader(event, "if-range"),
    etag,
  );
  if (range.kind === "unsatisfiable") {
    setResponseHeader(event, "Content-Range", `bytes */${size}`);
    return sendNoContent(event, 416);
  }
  if (range.kind === "partial") {
    setResponseStatus(event, 206);
    setResponseHeaders(event, {
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1),
    });
    return sendStream(
      event,
      createReadStream(filePath, { start: range.start, end: range.end }),
    );
  }
  setResponseHeader(event, "Content-Length", size);
  return sendStream(event, createReadStream(filePath));
}
