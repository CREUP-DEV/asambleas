import type { DocumentKind, DocumentStatus } from "../constants/domain";

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
 * Whether an automatic sub-item that stops being its document's (the
 * document moved away or was deleted, and the item stays) still carries the
 * document's title: not once a manager gave it its own (`titleCustom`).
 * Only then does it stay hidden with the document.
 */
export function keepsDocumentTitle(item: { titleCustom: boolean }): boolean {
  return !item.titleCustom;
}

/** What the visibility rules read of an agenda item. */
export interface TitleSource {
  generatedForDocumentId: string | null;
  hiddenWithDocumentId: string | null;
  /**
   * The item carries the title of a document deleted before everyone could
   * see it: only document managers read it (`seesWithheld`).
   */
  titleWithheld?: boolean;
}

/**
 * The document whose title the item may carry: the one it is the automatic
 * sub-item of, or the one it was the sub-item of before that document moved
 * away and the item stayed as an ordinary one (`hiddenWithDocumentId`).
 * Null for an item written by hand, and again once that document is
 * deleted or a manager gives the kept item a new title. Whoever cannot see
 * that document never reads the item's title.
 */
export function titleDocumentId(item: TitleSource): string | null {
  return item.generatedForDocumentId ?? item.hiddenWithDocumentId;
}

/**
 * Whether the item's title is someone's to hide: a document's
 * (titleDocumentId) or a withheld one.
 */
export function carriesGuardedTitle(item: TitleSource): boolean {
  return titleDocumentId(item) !== null || item.titleWithheld === true;
}

/**
 * Whether deleting a document in this status leaves its title withheld on
 * the items that carried it: it was not public (canSeeDocument).
 */
export function deletedTitleWithheld(status: string): boolean {
  return !isPublicDocumentStatus(status);
}

/**
 * The statuses in which everyone who sees the assembly reads a document
 * (canSeeDocument).
 */
export const PUBLIC_DOCUMENT_STATUSES = [
  "published",
  "postponed",
] as const satisfies readonly DocumentStatus[];

/** Whether a document in this status is public (PUBLIC_DOCUMENT_STATUSES). */
export function isPublicDocumentStatus(status: string): boolean {
  return (PUBLIC_DOCUMENT_STATUSES as readonly string[]).includes(status);
}

type ViewerItem = TitleSource & { id: string; parentId: string | null };
type ViewerDocument = { id: string; agendaItemId: string };

/**
 * The items whose title a viewer must not read: those that carry the title
 * of a document (titleDocumentId) the viewer cannot see, another member's
 * draft, and those whose title is withheld (`titleWithheld`) unless the
 * viewer manages documents (`seesWithheld`).
 */
export function hiddenTitleItemIds(
  items: readonly ViewerItem[],
  visibleDocuments: readonly { id: string }[],
  seesWithheld = false,
): Set<string> {
  const documentIds = new Set(visibleDocuments.map((document) => document.id));
  const hidden = new Set<string>();
  for (const item of items) {
    const documentId = titleDocumentId(item);
    if (
      (documentId !== null && !documentIds.has(documentId)) ||
      (item.titleWithheld === true && !seesWithheld)
    ) {
      hidden.add(item.id);
    }
  }
  return hidden;
}

/**
 * The agenda items a viewer gets. An item whose title the viewer must not
 * read (hiddenTitleItemIds) is left out, unless it holds a document the
 * viewer does see or has sub-items that stay: then it is kept, and the
 * caller sends it without its title (hiddenTitleItemIds again, on the
 * items returned).
 */
export function visibleAgendaItems<T extends ViewerItem>(
  items: readonly T[],
  visibleDocuments: readonly ViewerDocument[],
  seesWithheld = false,
): T[] {
  const itemsWithDocuments = new Set(
    visibleDocuments.map((document) => document.agendaItemId),
  );
  const hidden = hiddenTitleItemIds(items, visibleDocuments, seesWithheld);
  for (const id of itemsWithDocuments) hidden.delete(id);
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
