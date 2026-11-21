/**
 * Revalidation of a stored file the browser keeps but must ask about every
 * time (`Cache-Control: private, no-cache`): each request still goes
 * through the handler's access checks, and only a file the browser already
 * holds unchanged answers 304 with no body.
 */

/** The cache headers of such a file: kept privately, revalidated each time. */
export const REVALIDATED_FILE_CACHE_CONTROL = "private, no-cache";

/** A strong validator of a file on disk: its size and its last change. */
export function fileEtag(stats: { size: number; mtimeMs: number }): string {
  return `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

/**
 * Whether an `If-None-Match` header names this ETag (or `*`), compared the
 * weak way RFC 9110 asks of it: a `W/` prefix on either side is ignored.
 */
export function etagMatches(
  header: string | null | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  const wanted = bare(etag);
  return header.split(",").some((tag) => bare(tag) === wanted);
}
