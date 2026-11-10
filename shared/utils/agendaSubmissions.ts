import type { DocumentKind } from "../constants/domain";

/**
 * Agenda items where members present documents ("container" items), and the
 * automatic sub-items the server creates under them, one per document.
 *
 * A container has `acceptsSubmissions` on and may name the document kinds it
 * takes in `submissionKinds`; an empty list means every kind. The rule binds
 * members only: the Secretaría (document managers) puts any kind anywhere.
 */

/** Stable `data.reason` of the 422 a member gets for a kind the item refuses. */
export const SUBMISSION_KIND_REFUSED_REASON = "submission_kind";

/**
 * Stable `data.reason` of the 422 anyone gets for putting a document in the
 * automatic sub-item of another document.
 */
export const AUTO_ITEM_REFUSED_REASON = "auto_item";

/**
 * Stable `data.code` of the 409 a delete of an agenda item gets while a
 * document under it has amendments. `data` also carries `documents` (how
 * many documents have any) and `amendments` (how many rows in all).
 */
export const AGENDA_DELETE_AMENDMENTS_CODE = "agenda_item_amendments";

/**
 * Stable `data.code` of the 409 a delete of an agenda item gets during the
 * session while the item, a sub-item or one of their documents is being
 * projected, or one of them has speaking turns still open.
 */
export const AGENDA_DELETE_LIVE_CODE = "agenda_item_live";

/** More documents than this in one bulk request is surely a mistake. */
export const BULK_DOCUMENTS_MAX = 30;

export interface SubmissionRules {
  acceptsSubmissions: boolean;
  submissionKinds: readonly DocumentKind[];
}

/** Whether a member may present a document of `kind` under the item. */
export function itemAcceptsKind(
  item: SubmissionRules,
  kind: DocumentKind,
): boolean {
  if (!item.acceptsSubmissions) return false;
  return (
    item.submissionKinds.length === 0 || item.submissionKinds.includes(kind)
  );
}

/**
 * The kinds stored for an item: none while it takes no submissions, and
 * each one once, in the order given.
 */
export function normalizeSubmissionKinds(
  acceptsSubmissions: boolean,
  kinds: readonly DocumentKind[] | null | undefined,
): DocumentKind[] {
  if (!acceptsSubmissions) return [];
  return [...new Set(kinds ?? [])];
}

/**
 * Whether the item is an automatic sub-item: the one created for a document
 * presented under a container.
 */
export function isAutoItem(item: {
  generatedForDocumentId: string | null;
}): boolean {
  return item.generatedForDocumentId !== null;
}

/**
 * Whether an automatic sub-item takes the new title of its document: the
 * document still hangs from it and no manager gave the item its own title.
 */
export function followsDocumentTitle(
  item: {
    id: string;
    generatedForDocumentId: string | null;
    titleCustom: boolean;
  },
  document: { id: string; agendaItemId: string },
): boolean {
  return (
    item.generatedForDocumentId === document.id &&
    document.agendaItemId === item.id &&
    !item.titleCustom
  );
}

/**
 * Whether the automatic sub-item of a document goes with it when the
 * document is deleted or moved elsewhere: only while it holds nothing else.
 */
export function autoItemRemovable(
  item: { generatedForDocumentId: string | null },
  documentId: string,
  holds: { otherDocuments: number; children: number },
): boolean {
  return (
    item.generatedForDocumentId === documentId &&
    holds.otherDocuments === 0 &&
    holds.children === 0
  );
}

/**
 * The agenda items a viewer gets. The automatic sub-item of a document the
 * viewer cannot see (another member's draft) carries that document's title,
 * so it is left out with it, unless it holds a document the viewer does see
 * or has sub-items that stay.
 */
export function visibleAgendaItems<
  T extends {
    id: string;
    parentId: string | null;
    generatedForDocumentId: string | null;
  },
>(
  items: readonly T[],
  visibleDocuments: readonly { id: string; agendaItemId: string }[],
): T[] {
  const documentIds = new Set(visibleDocuments.map((document) => document.id));
  const itemsWithDocuments = new Set(
    visibleDocuments.map((document) => document.agendaItemId),
  );
  const hidden = new Set(
    items
      .filter(
        (item) =>
          item.generatedForDocumentId !== null &&
          !documentIds.has(item.generatedForDocumentId) &&
          !itemsWithDocuments.has(item.id),
      )
      .map((item) => item.id),
  );
  if (hidden.size === 0) return [...items];
  // A hidden candidate with a sub-item that stays is kept: taking it out
  // would leave that sub-item without its parent.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parentId && hidden.has(item.parentId) && !hidden.has(item.id)) {
        hidden.delete(item.parentId);
        changed = true;
      }
    }
  }
  return items.filter((item) => !hidden.has(item.id));
}

/**
 * Why an agenda item cannot be deleted with what hangs from it, or null
 * when it can. Only amendments keep it: they are other members' work.
 * `amendmentCounts` holds, per document under the item, every amendment row
 * of any status (drafts and withdrawn ones included).
 */
export function agendaDeleteBlocker(
  amendmentCounts: readonly number[],
): { documents: number; amendments: number } | null {
  const withAmendments = amendmentCounts.filter((total) => total > 0);
  if (withAmendments.length === 0) return null;
  return {
    documents: withAmendments.length,
    amendments: withAmendments.reduce((sum, total) => sum + total, 0),
  };
}
