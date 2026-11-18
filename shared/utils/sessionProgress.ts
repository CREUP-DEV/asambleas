import type { DocumentStatus } from "../constants/domain";
import { isItemVotedDocument } from "./controlSheet";

/**
 * What the Mesa leaves treated when the debate moves on (user's decision of
 * 2026-11-18): when the live state goes from one agenda item to another,
 * the item it leaves, every item above it that the new one is not under,
 * and the automatic sub-items of their documents become treated in the
 * control sheet («Tratado», the Mesa's mark). Going down into a sub-item
 * leaves nothing: the item is still being debated. What still waits for a
 * vote is never treated by moving on (itemsAwaitingVote): it is treated
 * once voted.
 */

export interface ProgressItem {
  id: string;
  parentId: string | null;
  /** Set on a document's own automatic sub-item. */
  generatedForDocumentId: string | null;
  /** «Se vota el punto»: the item takes a vote of its own. */
  voted?: boolean;
}

export interface ProgressDocument {
  id: string;
  agendaItemId: string;
  voted: boolean;
  status: DocumentStatus;
  /** Its final vote, once recorded. */
  finalVoteId: string | null;
}

/**
 * The items that still wait for a vote: the item a voted document hangs
 * from and the document's own sub-item while its final vote is missing, an
 * item marked «Se vota el punto» (and voted through no document) without a
 * vote in force on it, and every item above one of those.
 */
export function itemsAwaitingVote(
  items: readonly ProgressItem[],
  documents: readonly ProgressDocument[],
  /** The items with a vote of their own in force. */
  votedItemIds: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const autoItemOf = new Map(
    items
      .filter((item) => item.generatedForDocumentId !== null)
      .map((item) => [item.generatedForDocumentId!, item.id]),
  );
  const waiting = new Set<string>();
  const throughDocuments = new Set<string>();
  for (const document of documents) {
    if (!isItemVotedDocument(document)) continue;
    throughDocuments.add(document.agendaItemId);
    if (document.finalVoteId !== null) continue;
    waiting.add(document.agendaItemId);
    const autoItem = autoItemOf.get(document.id);
    if (autoItem) waiting.add(autoItem);
  }
  for (const item of items) {
    if (
      item.voted &&
      !throughDocuments.has(item.id) &&
      !votedItemIds.has(item.id)
    ) {
      waiting.add(item.id);
    }
  }
  for (const id of [...waiting]) {
    for (const ancestor of ancestorsOf(byId, id)) waiting.add(ancestor);
  }
  return waiting;
}

/** The ids of an item's ancestors, nearest first. */
function ancestorsOf(
  byId: ReadonlyMap<string, ProgressItem>,
  id: string,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let parent = byId.get(id)?.parentId ?? null;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    result.push(parent);
    parent = byId.get(parent)?.parentId ?? null;
  }
  return result;
}

/**
 * The items to mark treated when the debate goes from `leftId` to
 * `nextId`, in agenda order of discovery (the item left first). Empty when
 * nothing is left behind: no item before, the same item, or the new one
 * under the item left.
 */
export function itemsLeftTreated(
  items: readonly ProgressItem[],
  leftId: string | null,
  nextId: string | null,
  /** Items that still wait for a vote (itemsAwaitingVote): never marked. */
  awaitingVote: ReadonlySet<string> = new Set(),
): string[] {
  if (!leftId || !nextId || leftId === nextId) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  if (!byId.has(leftId)) return [];
  const nextLine = new Set([nextId, ...ancestorsOf(byId, nextId)]);
  if (nextLine.has(leftId)) return [];

  const left = [
    leftId,
    ...ancestorsOf(byId, leftId).filter((id) => !nextLine.has(id)),
  ];
  const result = new Set(left);
  for (const item of items) {
    if (
      item.generatedForDocumentId !== null &&
      item.parentId !== null &&
      result.has(item.parentId)
    ) {
      result.add(item.id);
    }
  }
  return [...result].filter((id) => !awaitingVote.has(id));
}
