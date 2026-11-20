import type {
  ControlSheetManualResult,
  DocumentStatus,
} from "../constants/domain";
import {
  isItemVotedDocument,
  isSettledManualResult,
  itemDocumentsOutcome,
  itemOutcome,
  type SheetDocument,
  type SheetItemVote,
} from "./controlSheet";

/**
 * What the Mesa leaves treated as the session goes (user's decision of
 * 2026-11-19, replacing "on leaving" of 2026-11-18): what the Mesa presents
 * in session (the live state points at it: an agenda item, or a document,
 * whose own item it is) becomes treated in the control sheet at once
 * («Tratado», the Mesa's mark), and only that: never the items above it nor
 * the other documents of a group. What still waits for a vote
 * (itemsAwaitingVote) is never marked: it is treated once voted, and a mark
 * on it counts for nothing meanwhile (itemOutcome). The Mesa unticks a mark
 * from the sheet or the console; it comes back only when the item is
 * presented again.
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

/** What the live state presents: an agenda item, and a document's own item. */
export interface PresentedTarget {
  agendaItemId: string | null;
  /** The agenda item the document on screen hangs from (its own sub-item). */
  documentItemId: string | null;
}

/**
 * The items presenting `target` marks treated: the item the live state
 * points at and the item of the document on screen, when it differs (a
 * body naming a group and one of its documents), each once and only if the
 * agenda has it. Never an item above them, never one still waiting for a
 * vote.
 */
export function itemsPresentedTreated(
  items: readonly ProgressItem[],
  target: PresentedTarget,
  /** Items that still wait for a vote (itemsAwaitingVote): never marked. */
  awaitingVote: ReadonlySet<string> = new Set(),
): string[] {
  const known = new Set(items.map((item) => item.id));
  const ids = [target.agendaItemId, target.documentItemId].filter(
    (id): id is string => id !== null && known.has(id),
  );
  return [...new Set(ids)].filter((id) => !awaitingVote.has(id));
}

/** What the sheet notes about one item, as the console reads its treatment. */
export interface ProgressMark {
  agendaItemId: string;
  /** The Mesa's mark is set. */
  treated: boolean;
  manualResult: ControlSheetManualResult | null;
  /** The mark's lock token (`progressUpdatedAt`), set or not. */
  token: string | null;
}

/**
 * Why an item reads treated in the console: `auto`, by its votes or by
 * what became of its documents; `result`, a «Retirado» or «Decaído» by
 * hand; `mark`, the Mesa's mark (the only one the console undoes);
 * `children`, a group whose items are all treated. Null while untreated.
 */
export type ItemTreatedBy = "auto" | "result" | "mark" | "children";

export interface ItemTreatment {
  id: string;
  treated: boolean;
  by: ItemTreatedBy | null;
  /** It still waits for a vote: nothing but the vote treats it. */
  awaitingVote: boolean;
  /**
   * The Mesa's mark is set, whether it counts or not (one set before the
   * item came to wait for a vote counts for nothing meanwhile).
   */
  marked: boolean;
  /** The mark's lock token, null while the sheet has no row for it. */
  token: string | null;
}

/**
 * Where every agenda item stands for the Mesa's console, by the control
 * sheet's own rule (itemOutcome, over the documents past draft, as the sheet
 * lists them), so the console and the sheet always agree. A group (an item
 * with items under it) the sheet does not treat by itself reads treated
 * once every item under it is, unless it waits for a vote.
 */
export function sessionTreatedItems(
  items: readonly (ProgressItem & { voted: boolean })[],
  documents: readonly (ProgressDocument & Pick<SheetDocument, "finalVote">)[],
  /** Votes on agenda items, voided ones included. */
  itemVotes: readonly (SheetItemVote & { subjectId: string })[],
  marks: readonly ProgressMark[],
): ItemTreatment[] {
  const votedItemIds = new Set(
    itemVotes
      .filter((vote) => vote.voidedAt === null)
      .map((vote) => vote.subjectId),
  );
  const awaiting = itemsAwaitingVote(items, documents, votedItemIds);
  const documentsByItem = new Map<string, SheetDocument[]>();
  for (const document of documents) {
    if (document.status === "draft") continue;
    const list = documentsByItem.get(document.agendaItemId) ?? [];
    list.push(document);
    documentsByItem.set(document.agendaItemId, list);
  }
  const votesByItem = new Map<string, SheetItemVote[]>();
  for (const vote of itemVotes) {
    const list = votesByItem.get(vote.subjectId) ?? [];
    list.push(vote);
    votesByItem.set(vote.subjectId, list);
  }
  const markOf = new Map(marks.map((mark) => [mark.agendaItemId, mark]));
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const list = children.get(item.parentId) ?? [];
    list.push(item.id);
    children.set(item.parentId, list);
  }

  const own = new Map<string, ItemTreatment>();
  for (const item of items) {
    const itemDocuments = documentsByItem.get(item.id) ?? [];
    const ownVotes = {
      voted: item.voted,
      votes: votesByItem.get(item.id) ?? [],
    };
    const mark = markOf.get(item.id);
    const waits = awaiting.has(item.id);
    const outcome = itemOutcome(
      itemDocuments,
      mark ? { manualResult: mark.manualResult, treated: mark.treated } : null,
      ownVotes,
      waits,
    );
    const by: ItemTreatedBy | null = !outcome.treated
      ? null
      : itemDocumentsOutcome(itemDocuments, ownVotes).treated
        ? "auto"
        : isSettledManualResult(mark?.manualResult)
          ? "result"
          : "mark";
    own.set(item.id, {
      id: item.id,
      treated: outcome.treated,
      by,
      awaitingVote: waits,
      marked: Boolean(mark?.treated),
      token: mark?.token ?? null,
    });
  }

  // Groups, children first: treated once all under them are.
  const resolved = new Map<string, ItemTreatment>();
  const resolve = (id: string, trail: Set<string>): ItemTreatment => {
    const done = resolved.get(id);
    if (done) return done;
    const base = own.get(id)!;
    const under = (children.get(id) ?? []).filter(
      (child) => own.has(child) && !trail.has(child),
    );
    let result = base;
    if (!base.treated && !base.awaitingVote && under.length > 0) {
      const next = new Set(trail).add(id);
      if (under.every((child) => resolve(child, next).treated)) {
        result = { ...base, treated: true, by: "children" };
      }
    }
    resolved.set(id, result);
    return result;
  };
  return items.map((item) => resolve(item.id, new Set([item.id])));
}

/**
 * Whether the Mesa can set (`mark`) or undo (`unmark`) the treated mark of
 * an item from the console (user's decision of 2026-11-19): undo a mark
 * that treats it, and one set before it came to wait for a vote, which
 * counts for nothing meanwhile but stays undoable (taking a mark away is
 * always allowed); never undo what its votes, a result by hand or its items
 * treat; set it only on an item neither treated nor waiting for a vote.
 */
export function sessionMarkAction(
  entry: Pick<ItemTreatment, "treated" | "by" | "awaitingVote" | "marked">,
): "mark" | "unmark" | null {
  if (entry.by === "mark" || (entry.awaitingVote && entry.marked)) {
    return "unmark";
  }
  if (!entry.treated && !entry.awaitingVote) return "mark";
  return null;
}
