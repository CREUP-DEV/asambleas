/**
 * What a link to a document's page may ask of it, in its query. The page
 * reads them once, on arrival (`landOnAmendment`).
 */

/**
 * `?enmendar=<block id>`: open the amendment editor at that paragraph of the
 * published text (at the start when the id is not one of its blocks). Only
 * for whoever may amend the document.
 */
export const DOCUMENT_AMEND_QUERY = "enmendar";

/** `?enmiendas=sin-leer`: the amendments the account still has to read. */
export const DOCUMENT_AMENDMENTS_QUERY = "enmiendas";
export const DOCUMENT_AMENDMENTS_UNREAD = "sin-leer";

/** A document's page with its amendments left to read listed. */
export function unreadAmendmentsPath(documentPath: string): string {
  return `${documentPath}?${DOCUMENT_AMENDMENTS_QUERY}=${DOCUMENT_AMENDMENTS_UNREAD}`;
}

/** A document's page with the amendment editor open at a paragraph. */
export function amendDocumentPath(
  documentPath: string,
  blockId: string | null,
): string {
  return `${documentPath}?${DOCUMENT_AMEND_QUERY}=${encodeURIComponent(blockId ?? "1")}`;
}
