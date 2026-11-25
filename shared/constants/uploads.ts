/**
 * Size limits of uploads that the server enforces. The handler, the route
 * rule of `nuxt.config.ts` (nuxt-security's request size limiter), the
 * client's own checks and the tests import them from here; nobody writes
 * the number again. No imports: `nuxt.config.ts` loads this file.
 */

/** The largest image a document's text accepts (PNG or JPEG), 10 MB. */
export const DOCUMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Room a route rule leaves over a file's own limit for the rest of the
 * multipart request. The handler refuses a body declared larger than the
 * file's limit plus 64 KiB with its own 413, worded with the figure
 * (`readUploadedFile`); nuxt-security's 413 carries no message, so the rule
 * must sit above that, never at the file's limit itself.
 */
export const UPLOAD_REQUEST_MARGIN_BYTES = 1024 * 1024;
