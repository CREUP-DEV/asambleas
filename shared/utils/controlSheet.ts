/**
 * The control sheet's rules (hoja de control, docs/control-sheet-plan.md):
 * which agenda items it lists, when an item or an amendment counts as
 * treated and what result it reads. Pure, so the page, the Mesa's console
 * and the Excel download word everything the same way.
 */

import type {
  AmendmentStatus,
  ApprovalMethod,
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
 * A counted vote nobody voted against or abstained in: the sheet reads it
 * «Aprobado (unanimidad)», with the rule the approval line of the PDFs uses
 * (approvedBy in content/approvalLine.ts), so the minutes never disagree.
 * Blank and invalid ballots are no vote. An assent is not unanimity by
 * itself.
 */
export function isUnanimousVote(vote: SheetVote): boolean {
  return (
    vote.method !== "assent" &&
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

export interface ItemOutcome {
  /** Null while it is still to be voted, or when nothing says. */
  result: ControlSheetResult | null;
  treated: boolean;
  /** The result comes from votes: nothing noted by hand replaces it. */
  byVote: boolean;
}

/**
 * Where an agenda item stands by its documents alone. An item is voted when
 * one of its documents is (and was neither withdrawn nor postponed): it is
 * treated once each of those has its final vote, and reads their result. An
 * item whose documents were all withdrawn or postponed reads that and is
 * treated. One whose documents are not voted (reports) reads «No aplica»
 * and is still to be marked treated.
 */
export function itemDocumentsOutcome(
  documents: readonly SheetDocument[],
): ItemOutcome {
  if (documents.length === 0)
    return { result: null, treated: false, byVote: false };
  const voted = documents.filter(
    (document) =>
      document.voted && !SETTLED_ELSEWHERE.includes(document.status),
  );
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
  return { result: "not_applicable", treated: false, byVote: false };
}

/** What the sheet noted by hand about an item. */
export interface SheetItemNotes {
  manualResult: ControlSheetManualResult | null;
  /** The Mesa marked it treated. */
  treated: boolean;
}

/**
 * Where an agenda item stands: its documents' votes first; then what the
 * sheet noted by hand (a «Decaído» or «Retirado» counts as treated); then
 * what its documents say otherwise.
 */
export function itemOutcome(
  documents: readonly SheetDocument[],
  notes: SheetItemNotes | null,
): ItemOutcome {
  const base = itemDocumentsOutcome(documents);
  if (base.byVote || !notes) {
    return { ...base, treated: base.treated || Boolean(notes?.treated) };
  }
  const settled =
    notes.manualResult === "withdrawn" || notes.manualResult === "lapsed";
  return {
    result: notes.manualResult ?? base.result,
    treated: base.treated || notes.treated || settled,
    byVote: false,
  };
}

/** What an amendment needs for the sheet to say whether it was treated. */
export interface SheetAmendment {
  status: AmendmentStatus;
  approvalMethod: ApprovalMethod | null;
  decidedAt: string | null;
}

/**
 * Whether the Mesa settled the amendment during the session: decided once
 * the assembly went into session, by a vote, by assent, as a matter of form,
 * withdrawn, lapsed, replaced or not admitted. One its presenter
 * incorporated, or one settled before the session, is marked by hand.
 */
export function amendmentTreatedInSession(
  amendment: SheetAmendment,
  sessionStartedAt: string | null,
): boolean {
  if (!sessionStartedAt || !amendment.decidedAt) return false;
  if (amendment.status === "draft" || amendment.status === "submitted") {
    return false;
  }
  if (
    amendment.status === "approved" &&
    amendment.approvalMethod === "proponent"
  ) {
    return false;
  }
  return Date.parse(amendment.decidedAt) >= Date.parse(sessionStartedAt);
}

/** An agenda item as the sheet lists it. */
export interface SheetItem {
  id: string;
  parentId: string | null;
}

/** A row of the sheet's «General»: an item it lists, or one above them. */
export interface ControlSheetRow<T extends SheetItem> {
  item: T;
  /**
   * `item`: a row of its own. `heading`: an item above listed ones, shown so
   * they read under their parent («14. Resoluciones»).
   */
  kind: "item" | "heading";
}

/**
 * The rows of «General», in the order of `ordered` (the agenda in reading
 * order): every item with a document the reader sees, every item in
 * `extraIds` (listed by hand, or with votes of its own), and above them the
 * items they hang from, as headings.
 */
export function controlSheetRows<T extends SheetItem>(
  ordered: readonly T[],
  documents: readonly { agendaItemId: string }[],
  extraIds: ReadonlySet<string> = new Set(),
): ControlSheetRow<T>[] {
  const byId = new Map(ordered.map((item) => [item.id, item]));
  const listed = new Set<string>(extraIds);
  for (const document of documents) listed.add(document.agendaItemId);
  const headings = new Set<string>();
  for (const id of listed) {
    const seen = new Set<string>([id]);
    let parentId = byId.get(id)?.parentId ?? null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      if (!listed.has(parentId)) headings.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  return ordered.flatMap((item): ControlSheetRow<T>[] => {
    if (listed.has(item.id)) return [{ item, kind: "item" }];
    if (headings.has(item.id)) return [{ item, kind: "heading" }];
    return [];
  });
}

/** One member or person in «Intervinientes». */
export interface SheetSpeaker {
  /** The member's acronym, or the person's name when no member was noted. */
  label: string;
  /** The names written down for it, in order, each once. */
  names: string[];
  /** How many times it took the floor there. */
  times: number;
}

/** What a turn needs for «Intervinientes». */
export interface SheetTurn {
  member: { id: string; acronym: string } | null;
  speaker: string | null;
}

/**
 * The speakers of a row, each once, in the order they first spoke, with how
 * many times and the names written down for them.
 */
export function sheetSpeakers(turns: readonly SheetTurn[]): SheetSpeaker[] {
  const byKey = new Map<string, SheetSpeaker>();
  for (const turn of turns) {
    const name = turn.speaker?.trim() || null;
    const key = turn.member ? `m:${turn.member.id}` : name ? `n:${name}` : null;
    if (!key) continue;
    const label = turn.member ? turn.member.acronym : name!;
    const entry = byKey.get(key) ?? { label, names: [], times: 0 };
    entry.times += 1;
    if (turn.member && name && !entry.names.includes(name)) {
      entry.names.push(name);
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}
