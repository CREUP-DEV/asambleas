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

/**
 * A stretch of the published text, as a reader selects it: from a point of
 * one block to a point of the same block or a later one. Offsets count the
 * characters of the block's text as it shows.
 */
export interface TextPoint {
  blockId: string;
  offset: number;
}
export interface TextSpan {
  start: TextPoint;
  end: TextPoint;
}

/**
 * `&seleccion=<from>.<end block id>.<to>`, next to `enmendar` (which names
 * the block the selection starts in): the editor opens with that text
 * selected.
 */
export const DOCUMENT_AMEND_SELECTION_QUERY = "seleccion";

/** The selection a link asks for; null when it names none, or a broken one. */
export function parseAmendSelection(
  blockId: string,
  value: unknown,
): TextSpan | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,7})\.([\w-]{1,64})\.(\d{1,7})$/.exec(value);
  if (!match) return null;
  return {
    start: { blockId, offset: Number(match[1]) },
    end: { blockId: match[2]!, offset: Number(match[3]) },
  };
}

/** `?enmiendas=sin-leer`: the amendments the account still has to read. */
export const DOCUMENT_AMENDMENTS_QUERY = "enmiendas";
export const DOCUMENT_AMENDMENTS_UNREAD = "sin-leer";

/** A document's page with its amendments left to read listed. */
export function unreadAmendmentsPath(documentPath: string): string {
  return `${documentPath}?${DOCUMENT_AMENDMENTS_QUERY}=${DOCUMENT_AMENDMENTS_UNREAD}`;
}

/**
 * A document's page with the amendment editor open at a paragraph, and
 * with a stretch of text selected when one is given.
 */
export function amendDocumentPath(
  documentPath: string,
  blockId: string | null,
  span: TextSpan | null = null,
): string {
  const path = `${documentPath}?${DOCUMENT_AMEND_QUERY}=${encodeURIComponent(blockId ?? "1")}`;
  if (!span || span.start.blockId !== blockId) return path;
  const selection = [
    span.start.offset,
    encodeURIComponent(span.end.blockId),
    span.end.offset,
  ].join(".");
  return `${path}&${DOCUMENT_AMEND_SELECTION_QUERY}=${selection}`;
}
