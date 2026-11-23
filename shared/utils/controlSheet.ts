/**
 * The control sheet's rules (hoja de control, docs/control-sheet-plan.md):
 * which agenda items it lists, when an item or an amendment counts as
 * treated and what result it reads. Pure, so the page, the Mesa's console
 * and the Excel download word everything the same way.
 */

import type {
  AmendmentStatus,
  ControlSheetManualResult,
  DocumentStatus,
  VoteMethod,
  VoteResult,
} from "../constants/domain";

/** What a vote needs for the sheet to word it. */
export interface SheetVote {
  method: VoteMethod;
  result: VoteResult;
  inFavor: number;
  against: number;
  abstentions: number;
  blank: number;
  invalid: number;
  /** An assent nobody objected to when unanimity was asked. */
  unanimous?: boolean;
}

/** A vote on the agenda item itself, as the sheet reads it. */
export interface SheetItemVote extends SheetVote {
  id: string;
  recordedAt: string;
  /** Voided by the Mesa: it no longer gives the item's result. */
  voidedAt: string | null;
}

/**
 * What the item itself says about its vote: «Se vota el punto» (`voted`)
 * and the votes on it, voided ones included.
 */
export interface SheetItemOwn {
  voted: boolean;
  votes: readonly SheetItemVote[];
}

/** What a document needs for the sheet to word its item. */
export interface SheetDocument {
  id: string;
  agendaItemId: string;
  status: DocumentStatus;
  voted: boolean;
  finalVote: SheetVote | null;
}

/** The result a row of the sheet reads. */
export type ControlSheetResult =
  | "approved"
  | "approved_unanimous"
  | "rejected"
  /** Its voted documents came out differently: each says how. */
  | "mixed"
  | "withdrawn"
  /** Noted by hand: «Decaído». */
  | "lapsed"
  | "postponed"
  | "not_applicable";

/**
 * A counted vote nobody voted against or abstained in, or an assent nobody
 * objected to when unanimity was asked: the sheet reads it «Aprobado
 * (unanimidad)», with the rule the approval line of the PDFs uses
 * (approvedBy in content/approvalLine.ts), so the minutes never disagree.
 * Blank and invalid ballots are no vote. An assent is not unanimity by
 * itself.
 */
export function isUnanimousVote(vote: SheetVote): boolean {
  if (vote.method === "assent") {
    return vote.result === "approved" && vote.unanimous === true;
  }
  return (
    vote.result === "approved" &&
    vote.inFavor > 0 &&
    vote.against === 0 &&
    vote.abstentions === 0
  );
}

/** What one vote reads as a result. */
export function voteSheetResult(vote: SheetVote): ControlSheetResult {
  if (vote.result === "rejected") return "rejected";
  return isUnanimousVote(vote) ? "approved_unanimous" : "approved";
}

/** Statuses that take a document out of this assembly's votes. */
const SETTLED_ELSEWHERE: readonly DocumentStatus[] = ["withdrawn", "postponed"];

/**
 * A document whose final vote is one of its item's votes: voted, presented,
 * and neither withdrawn nor postponed.
 */
export function isItemVotedDocument(document: {
  voted: boolean;
  status: DocumentStatus;
}): boolean {
  return (
    document.voted &&
    document.status !== "draft" &&
    !SETTLED_ELSEWHERE.includes(document.status)
  );
}

/**
 * Whether the item is voted through its documents' final votes. Then it
 * takes no vote of its own: the server refuses one (422
 * `item_has_voted_documents`) and the console and the sheet offer none, all
 * through this one rule.
 */
export function itemHasVotedDocuments(
  documents: readonly { voted: boolean; status: DocumentStatus }[],
): boolean {
  return documents.some(isItemVotedDocument);
}

/**
 * Whether the item takes a vote of its own: not an item where members
 * present (each document is voted in its own sub-item) and not voted
 * through its documents. The server refuses any other (422), and the console
 * and the sheet offer none.
 */
export function itemTakesOwnVote(
  item: { acceptsSubmissions: boolean },
  documents: readonly { voted: boolean; status: DocumentStatus }[],
): boolean {
  return !item.acceptsSubmissions && !itemHasVotedDocuments(documents);
}

/**
 * The vote on the item in force: the latest one not voided (by the time it
 * was recorded, then by id), or null.
 */
export function latestItemVote<T extends SheetItemVote>(
  votes: readonly T[],
): T | null {
  let latest: T | null = null;
  for (const vote of votes) {
    if (vote.voidedAt !== null) continue;
    if (
      !latest ||
      vote.recordedAt > latest.recordedAt ||
      (vote.recordedAt === latest.recordedAt && vote.id > latest.id)
    ) {
      latest = vote;
    }
  }
  return latest;
}

/**
 * The items the sheet lists for their own vote: «Se vota el punto», or a
 * vote on them in force.
 */
export function ownVoteItemIds(
  items: readonly { id: string; voted: boolean }[],
  votes: readonly { subjectId: string; voidedAt: string | null }[],
): Set<string> {
  const ids = new Set(
    items.filter((item) => item.voted).map((item) => item.id),
  );
  for (const vote of votes) {
    if (vote.voidedAt === null) ids.add(vote.subjectId);
  }
  return ids;
}

export interface ItemOutcome {
  /** Null while it is still to be voted, or when nothing says. */
  result: ControlSheetResult | null;
  treated: boolean;
  /** The result comes from votes: nothing noted by hand replaces it. */
  byVote: boolean;
}

/**
 * Where an agenda item stands by its votes and its documents, before
 * anything noted by hand. An item is voted through its documents when one
 * of them is (isItemVotedDocument): it is treated once each of those has its
 * final vote, and reads their result; a vote on the item itself counts for
 * nothing then. Otherwise the vote on the item in force (latestItemVote)
 * gives its result and treats it. An item whose documents were all
 * withdrawn or postponed reads that and is treated. One whose documents are
 * not voted (reports) reads «No aplica», unless «Se vota el punto» says it
 * is still to be voted («Pendiente»); either way it is still to be marked
 * treated.
 */
export function itemDocumentsOutcome(
  documents: readonly SheetDocument[],
  own: SheetItemOwn | null = null,
): ItemOutcome {
  const voted = documents.filter(isItemVotedDocument);
  if (voted.length === 0) {
    const vote = own ? latestItemVote(own.votes) : null;
    if (vote) {
      return { result: voteSheetResult(vote), treated: true, byVote: true };
    }
  }
  if (documents.length === 0)
    return { result: null, treated: false, byVote: false };
  if (voted.length > 0) {
    const votes = voted.map((document) => document.finalVote);
    if (votes.some((vote) => vote === null)) {
      return { result: null, treated: false, byVote: false };
    }
    const results = new Set(
      votes.map((vote) => voteSheetResult(vote as SheetVote)),
    );
    if (results.size === 1) {
      return { result: [...results][0]!, treated: true, byVote: true };
    }
    if (!results.has("rejected")) {
      return { result: "approved", treated: true, byVote: true };
    }
    return { result: "mixed", treated: true, byVote: true };
  }
  if (documents.every((document) => document.status === "withdrawn")) {
    return { result: "withdrawn", treated: true, byVote: false };
  }
  if (documents.every((document) => document.status === "postponed")) {
    return { result: "postponed", treated: true, byVote: false };
  }
  if (
    documents.every((document) => SETTLED_ELSEWHERE.includes(document.status))
  ) {
    return { result: "mixed", treated: true, byVote: false };
  }
  if (own?.voted) return { result: null, treated: false, byVote: false };
  return { result: "not_applicable", treated: false, byVote: false };
}

/** What the sheet noted by hand about an item. */
export interface SheetItemNotes {
  manualResult: ControlSheetManualResult | null;
  /** The Mesa marked it treated. */
  treated: boolean;
}

/** A result by hand that counts as treated: «Retirado» or «Decaído». */
export function isSettledManualResult(
  result: ControlSheetManualResult | null | undefined,
): boolean {
  return result === "withdrawn" || result === "lapsed";
}

/**
 * Where an agenda item stands: its votes first (its documents' or its own);
 * then what the sheet noted by hand (a «Decaído» or «Retirado» counts as
 * treated); then what its documents and «Se vota el punto» say otherwise.
 * An item that still waits for a vote (`awaitingVote`, itemsAwaitingVote in
 * sessionProgress.ts, over the whole agenda) is treated only by its votes
 * (user's decision of 2026-11-19): the Mesa's mark and a result by hand
 * count for nothing then, though the result still reads.
 */
export function itemOutcome(
  documents: readonly SheetDocument[],
  notes: SheetItemNotes | null,
  own: SheetItemOwn | null = null,
  awaitingVote = false,
): ItemOutcome {
  const base = itemDocumentsOutcome(documents, own);
  const marked = !awaitingVote && Boolean(notes?.treated);
  if (base.byVote || !notes) {
    return { ...base, treated: base.treated || marked };
  }
  const settled = !awaitingVote && isSettledManualResult(notes.manualResult);
  return {
    result: notes.manualResult ?? base.result,
    treated: base.treated || marked || settled,
    byVote: false,
  };
}

/** What an amendment needs for the sheet to say whether it was treated. */
export interface SheetAmendment {
  status: AmendmentStatus;
  /** The Mesa has put it on screen in session (amendments.firstProjectedAt). */
  projected: boolean;
}

/**
 * Whether an amendment counts as treated by itself (user's decision of
 * 2026-11-21): every amendment past draft that is no longer pending
 * (decided, incorporated, withdrawn, lapsed, transacted, not admitted),
 * whenever that happened, and a pending one once the Mesa has put it on
 * screen. Only a pending amendment never projected is not.
 */
export function amendmentAutoTreated(amendment: SheetAmendment): boolean {
  if (amendment.status === "draft") return false;
  return amendment.status !== "submitted" || amendment.projected;
}

/** An agenda item as the sheet lists it. */
export interface SheetItem {
  id: string;
  parentId: string | null;
}

/** A row of the sheet's «General»: one agenda item. */
export interface ControlSheetRow<T extends SheetItem> {
  item: T;
  /** Every item is a row of its own (user's decision of 2026-11-21). */
  kind: "item";
}

/**
 * The rows of «General»: every agenda item the reader gets, in the order of
 * `ordered` (the agenda in reading order), with or without documents or
 * votes, so the sheet shows who spoke on each and whether it was treated
 * (user's decision of 2026-11-21; before, only items with documents, votes
 * or added by hand, the others as headings).
 */
export function controlSheetRows<T extends SheetItem>(
  ordered: readonly T[],
): ControlSheetRow<T>[] {
  return ordered.map((item) => ({ item, kind: "item" }));
}

/** One member or person in «Intervinientes». */
export interface SheetSpeaker {
  /** The member's acronym, or the person's name when no member was noted. */
  label: string;
  /** The names written down for it, in order, each once. */
  names: string[];
}

/** What a turn needs for «Intervinientes». */
export interface SheetTurn {
  member: { id: string; acronym: string } | null;
  speaker: string | null;
}

/**
 * The speakers of a row, each once, in the order they first spoke, with the
 * names written down for them: who spoke, never how many times (user's
 * decision of 2026-11-19). Turns given from the queue and those noted by
 * hand count alike.
 */
export function sheetSpeakers(turns: readonly SheetTurn[]): SheetSpeaker[] {
  const byKey = new Map<string, SheetSpeaker>();
  for (const turn of turns) {
    const name = turn.speaker?.trim() || null;
    const key = turn.member ? `m:${turn.member.id}` : name ? `n:${name}` : null;
    if (!key) continue;
    const label = turn.member ? turn.member.acronym : name!;
    const entry = byKey.get(key) ?? { label, names: [] };
    if (turn.member && name && !entry.names.includes(name)) {
      entry.names.push(name);
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}
