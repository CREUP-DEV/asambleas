/**
 * The control sheet's rows, worked out from the agenda the hub already
 * holds, the sheet's own answer (GET .../control-sheet) and, for one
 * document, its amendments. Pure, so it is unit-tested on its own
 * (-model.test.ts); the rules themselves are shared with the Excel
 * (shared/utils/controlSheet.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */

import type { AssemblyType } from "~~/shared/constants/assemblyTypes";
import type {
  AssemblySettings,
  AssemblyStatus,
} from "~~/shared/constants/domain";
import type {
  AgendaItemDto,
  AmendmentDto,
  ControlSheetAmendmentRowDto,
  ControlSheetDto,
  ControlSheetItemRowDto,
  ControlSheetPositionDto,
  DocumentSummaryDto,
  HeadcountDto,
  LiveEventDto,
  MemberRef,
  PositionDto,
  SpeakingTurnDto,
  VoteDto,
} from "~~/shared/types/api";
import {
  amendmentTreatedInSession,
  controlSheetRows,
  itemDocumentsOutcome,
  itemHasVotedDocuments,
  itemTakesOwnVote,
  itemOutcome,
  latestItemVote,
  ownVoteItemIds,
  sheetSpeakers,
  type ItemOutcome,
  type SheetItemOwn,
  type SheetSpeaker,
} from "~~/shared/utils/controlSheet";
import { buildAgendaTree, flattenAgendaTree } from "~/utils/agendaTree";
import {
  liveAmendmentNote,
  liveAmendmentState,
  type LiveAmendmentNote,
  type LiveAmendmentRow,
  type LiveAmendmentState,
} from "~/components/live-view/-model";
import { sortSessionAmendments } from "~/composables/session/sessionModel";
import type { AmendmentOrderOptions } from "~~/shared/utils/amendmentOrder";

/** A document as a row of «General» shows it. */
export interface SheetRowDocument {
  id: string;
  slug: string;
  title: string;
  status: DocumentSummaryDto["status"];
  voted: boolean;
  finalVote: VoteDto | null;
  /** The majority its final vote takes. */
  majority: DocumentSummaryDto["majority"];
  /** Its amendments still undecided, which hold back the final vote. */
  undecided: number;
  /** Optimistic lock token, for annulling its final vote. */
  updatedAt: string;
  /** The main presenter, as the server redacts it (offices may read "CEA"). */
  proponent: MemberRef | null;
  /** Those who present it with the main presenter, redacted the same way. */
  coProponents: MemberRef[];
}

/** A row of «General». */
export interface GeneralSheetRow {
  id: string;
  /** `heading`: an item above listed ones, shown for its title only. */
  kind: "item" | "heading";
  number: string | null;
  unlisted: boolean;
  title: string;
  /** The reader may not read its title: `title` is the neutral label. */
  titleHidden: boolean;
  /**
   * Someone who sees only what is public does not read its title
   * (AgendaItemDto.publicTitleHidden; true when the agenda does not say),
   * whoever reads the sheet: a vote's question never starts from it.
   */
  publicTitleHidden: boolean;
  depth: number;
  /**
   * Its place in the agenda read in order (pre-order): the order of «Nº»,
   * and what breaks ties in every other order.
   */
  index: number;
  /** The items it hangs from, the nearest first. */
  ancestorIds: string[];
  /**
   * The item it hangs from, for the orders that leave the headings out
   * ("Dentro de 14. Resoluciones"); null for a root item.
   */
  parent: { number: string | null; title: string } | null;
  documents: SheetRowDocument[];
  outcome: ItemOutcome;
  /**
   * Treated by its votes (its documents' or its own) or by what became of
   * its documents, whatever the Mesa marks.
   */
  autoTreated: boolean;
  speakers: SheetSpeaker[];
  /** What the sheet noted about it; null while nothing was. */
  sheet: ControlSheetItemRowDto | null;
  /** The Mesa has it in debate. */
  live: boolean;
  /** «Se vota el punto», from the agenda. */
  voted: boolean;
  /** The votes on the item itself, voided ones too, oldest first. */
  itemVotes: VoteDto[];
  /**
   * A document of the item is voted (itemHasVotedDocuments, over every
   * document of it the reader gets): those final votes are the item's, and
   * a vote of its own counts for nothing.
   */
  votedThroughDocuments: boolean;
  /**
   * A vote of its own may be recorded here: it is not voted through its
   * documents, and it is not an item where members present documents (a
   * container), whose documents are voted in their own sub-items.
   */
  takesOwnVote: boolean;
  /**
   * On the sheet by its own vote: «Se vota el punto», or a vote on it in
   * force (ownVoteItemIds), so taking it off by hand changes nothing.
   */
  ownListed: boolean;
}

/** The votes on agenda items by item, each list oldest first. */
function itemVotesById(votes: readonly VoteDto[]): Map<string, VoteDto[]> {
  const byItem = new Map<string, VoteDto[]>();
  for (const vote of votes) {
    if (vote.subjectType !== "agenda_item") continue;
    const list = byItem.get(vote.subjectId) ?? [];
    list.push(vote);
    byItem.set(vote.subjectId, list);
  }
  for (const list of byItem.values()) {
    list.sort(
      (a, b) =>
        a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id),
    );
  }
  return byItem;
}

/**
 * The rows of «General»: the items with documents past draft, the items on
 * the sheet by their own vote or added by hand, and the items above them,
 * numbered over the whole agenda (never over the rows shown), with their
 * votes (their documents' final votes or their own) and who spoke there.
 */
export function buildGeneralRows(
  items: readonly AgendaItemDto[],
  documents: readonly DocumentSummaryDto[],
  sheet: ControlSheetDto | null,
  liveItemId: string | null,
): GeneralSheetRow[] {
  const nodes = flattenAgendaTree(buildAgendaTree(items));
  const presented = documents.filter((document) => document.status !== "draft");
  const allDocumentsByItem = new Map<string, DocumentSummaryDto[]>();
  for (const document of documents) {
    const list = allDocumentsByItem.get(document.agendaItemId) ?? [];
    list.push(document);
    allDocumentsByItem.set(document.agendaItemId, list);
  }
  const itemVotes = sheet?.itemVotes ?? [];
  const votesByItem = itemVotesById(itemVotes);
  const finalVotes = new Map(
    (sheet?.documents ?? []).map((document) => [
      document.id,
      document.finalVote,
    ]),
  );
  const undecidedBy = new Map(
    (sheet?.documents ?? []).map((document) => [
      document.id,
      document.undecided,
    ]),
  );
  const documentsByItem = new Map<string, SheetRowDocument[]>();
  for (const document of presented) {
    const list = documentsByItem.get(document.agendaItemId) ?? [];
    list.push({
      id: document.id,
      slug: document.slug,
      title: document.title,
      status: document.status,
      voted: document.voted,
      finalVote: finalVotes.get(document.id) ?? null,
      majority: document.majority,
      undecided: undecidedBy.get(document.id) ?? 0,
      updatedAt: document.updatedAt,
      proponent: document.proponent,
      coProponents: document.coProponents,
    });
    documentsByItem.set(document.agendaItemId, list);
  }
  const turnsByItem = new Map<string, NonNullable<typeof sheet>["turns"]>();
  for (const turn of sheet?.turns ?? []) {
    // A turn on an amendment counts in the amendment's row, not the item's.
    if (!turn.agendaItemId || turn.amendmentId) continue;
    const list = turnsByItem.get(turn.agendaItemId) ?? [];
    list.push(turn);
    turnsByItem.set(turn.agendaItemId, list);
  }
  const nodeById = new Map(nodes.map((node) => [node.item.id, node]));
  const notes = new Map(
    (sheet?.itemRows ?? []).map((row) => [row.agendaItemId, row]),
  );
  const ownListed = ownVoteItemIds(items, itemVotes);
  const listed = new Set(ownListed);
  for (const row of sheet?.itemRows ?? []) {
    if (row.listed) listed.add(row.agendaItemId);
  }
  const rows = controlSheetRows(
    nodes.map((node) => node.item),
    presented,
    listed,
  );
  const indexById = new Map(nodes.map((node, index) => [node.item.id, index]));
  return rows.map(({ item, kind }) => {
    const node = nodeById.get(item.id)!;
    const rowDocuments = documentsByItem.get(item.id) ?? [];
    const sheetDocuments = rowDocuments.map((document) => ({
      ...document,
      agendaItemId: item.id,
    }));
    const note = notes.get(item.id) ?? null;
    const votes = votesByItem.get(item.id) ?? [];
    const own: SheetItemOwn = { voted: item.voted, votes };
    const votedThroughDocuments = itemHasVotedDocuments(
      allDocumentsByItem.get(item.id) ?? [],
    );
    const ancestorIds: string[] = [];
    let parentId = node.parentId;
    while (parentId && !ancestorIds.includes(parentId)) {
      ancestorIds.push(parentId);
      parentId = nodeById.get(parentId)?.parentId ?? null;
    }
    const parentNode = node.parentId ? nodeById.get(node.parentId) : undefined;
    return {
      id: item.id,
      kind,
      number: node.number,
      unlisted: item.unlisted,
      title: item.title,
      titleHidden: item.titleHidden,
      publicTitleHidden: item.publicTitleHidden !== false,
      depth: node.depth,
      index: indexById.get(item.id) ?? 0,
      ancestorIds,
      parent: parentNode
        ? { number: parentNode.number, title: parentNode.item.title }
        : null,
      documents: rowDocuments,
      outcome: itemOutcome(
        sheetDocuments,
        note
          ? { manualResult: note.manualResult, treated: note.treated !== null }
          : null,
        own,
      ),
      autoTreated: itemDocumentsOutcome(sheetDocuments, own).treated,
      speakers: sheetSpeakers(turnsByItem.get(item.id) ?? []),
      sheet: note,
      live: item.id === liveItemId,
      voted: item.voted,
      itemVotes: votes,
      votedThroughDocuments,
      takesOwnVote: itemTakesOwnVote(
        item,
        allDocumentsByItem.get(item.id) ?? [],
      ),
      ownListed: ownListed.has(item.id),
    };
  });
}

/**
 * What recording, voiding and marking unanimous a vote on an item depend on
 * besides the row: the assembly's state, type (the voting portal is for
 * AGETs only) and settings, and the Mesa's latest headcount (undefined
 * until it loads, null when there is none).
 */
export interface ItemVoteContext {
  status: AssemblyStatus;
  type: AssemblyType;
  settings: AssemblySettings;
  headcount: HeadcountDto | null | undefined;
}

/** One vote in the «Votaciones» cell of a row of «General». */
export interface RowVoteEntry {
  id: string;
  vote: VoteDto;
  /**
   * What was voted: the document's title when several documents have their
   * final vote, the question of a vote on the item; null otherwise.
   */
  label: string | null;
  /** A vote on the item itself. */
  ownVote: boolean;
  /** The vote on the item that gives its result (the latest in force). */
  decides: boolean;
}

/**
 * What the «Votaciones» cell shows: the documents' final votes, or, for an
 * item not voted through its documents, the votes on the item in force,
 * oldest first (the latest gives the result). Voided votes stay in the
 * panel only.
 */
export function rowVoteEntries(row: GeneralSheetRow): RowVoteEntry[] {
  const documentVotes = row.documents.filter((document) => document.finalVote);
  const entries: RowVoteEntry[] = documentVotes.map((document) => ({
    id: document.id,
    vote: document.finalVote!,
    label: documentVotes.length > 1 ? document.title : null,
    ownVote: false,
    decides: false,
  }));
  if (row.votedThroughDocuments) return entries;
  const latest = latestItemVote(row.itemVotes);
  for (const vote of row.itemVotes) {
    if (vote.voidedAt !== null) continue;
    entries.push({
      id: vote.id,
      vote,
      label: vote.question,
      ownVote: true,
      decides: vote.id === latest?.id,
    });
  }
  return entries;
}

/** A row of «Enmiendas». */
export interface AmendmentSheetRow {
  amendment: AmendmentDto;
  state: LiveAmendmentState;
  /**
   * What the badge alone does not say (replaced by T1, incorporated...);
   * never for one out of time, whose badge says it.
   */
  note: LiveAmendmentNote | null;
  treated: boolean;
  /** Treated because the Mesa settled it in session. */
  autoTreated: boolean;
  sheet: ControlSheetAmendmentRowDto | null;
  /**
   * The main presenter's answer: the one the sheet's own answer carries
   * (ControlSheetDto.positions, every sheet reader reads it), else the
   * amendment's (AmendmentDto.position, null when the assembly's rule hides
   * it from the reader).
   */
  position: PositionDto | null;
  live: boolean;
  /** Who spoke on it, each once (sheetSpeakers). */
  speakers: SheetSpeaker[];
}

/**
 * The presenter's answer to show: the sheet's and the amendment's come from
 * two fetches that may land in any order, so the later one wins (the
 * sheet's on a tie, since it reaches every sheet reader).
 */
export function newerPosition(
  sheet: PositionDto | null,
  amendment: PositionDto | null,
): PositionDto | null {
  if (!sheet || !amendment) return sheet ?? amendment;
  // Without a time (a reader not told when), the sheet's stands.
  if (!amendment.updatedAt || !sheet.updatedAt) return sheet;
  return Date.parse(amendment.updatedAt) > Date.parse(sheet.updatedAt)
    ? amendment
    : sheet;
}

/** The amendments of a document past draft, in the console's order. */
export function buildAmendmentRows(
  list: readonly AmendmentDto[],
  sessionStartedAt: string | null,
  liveAmendmentId: string | null,
  sheetRows: readonly ControlSheetAmendmentRowDto[] = [],
  positions: readonly ControlSheetPositionDto[] = [],
  turns: readonly SpeakingTurnDto[] = [],
  /** The console's order: by answer once the answers are public. */
  order: AmendmentOrderOptions = {},
): AmendmentSheetRow[] {
  const notes = new Map(sheetRows.map((row) => [row.amendmentId, row]));
  const turnsByAmendment = new Map<string, SpeakingTurnDto[]>();
  for (const turn of turns) {
    if (!turn.amendmentId) continue;
    const list = turnsByAmendment.get(turn.amendmentId) ?? [];
    list.push(turn);
    turnsByAmendment.set(turn.amendmentId, list);
  }
  const answers = new Map(
    positions.map((entry) => [entry.amendmentId, entry.position]),
  );
  const rows: LiveAmendmentRow[] = sortSessionAmendments(
    list.filter((amendment) => amendment.status !== "draft"),
    order,
  ).map((amendment) => ({
    amendment,
    state: liveAmendmentState(amendment, liveAmendmentId),
    current: amendment.id === liveAmendmentId,
  }));
  return rows.map((row) => {
    const autoTreated = amendmentTreatedInSession(
      row.amendment,
      sessionStartedAt,
    );
    const sheet = notes.get(row.amendment.id) ?? null;
    return {
      amendment: row.amendment,
      state: row.state,
      // «Fuera de plazo» says it all: the live view's sentence is left out.
      note: row.state === "late" ? null : liveAmendmentNote(row, rows),
      treated: autoTreated || Boolean(sheet?.treated),
      autoTreated,
      sheet,
      position: newerPosition(
        answers.get(row.amendment.id) ?? null,
        row.amendment.position,
      ),
      live: row.current,
      speakers: sheetSpeakers(turnsByAmendment.get(row.amendment.id) ?? []),
    };
  });
}

/**
 * Why the Mesa cannot change a row's treated mark by hand: `auto` when it
 * counts by itself (an item's documents' votes or what became of them; an
 * amendment the Mesa settled in session), `result` when an item's «Retirado»
 * or «Decaído» noted by hand makes it count. Null when the Mesa's mark
 * decides.
 */
export type TreatedLock = "auto" | "result" | null;

/** A row's treated mark as the panel edits it and the lists show it. */
export interface TreatedControl {
  treated: boolean;
  lock: TreatedLock;
  /** The lock token a change of the mark sends (`treated.updatedAt`). */
  token: string | null;
}

/** What the box in the lists draws: the value (the one on its way while it saves). */
export interface TreatedBox {
  treated: boolean;
  saving: boolean;
}

export function itemTreatedControl(row: GeneralSheetRow): TreatedControl {
  const byResult =
    row.sheet?.manualResult === "withdrawn" ||
    row.sheet?.manualResult === "lapsed";
  return {
    treated: row.outcome.treated,
    lock: row.autoTreated ? "auto" : byResult ? "result" : null,
    token: row.sheet?.progressUpdatedAt ?? null,
  };
}

export function amendmentTreatedControl(
  row: AmendmentSheetRow,
): TreatedControl {
  return {
    treated: row.treated,
    lock: row.autoTreated ? "auto" : null,
    token: row.sheet?.treatedUpdatedAt ?? null,
  };
}

/**
 * The row a write to the sheet answered 409 `control_sheet_stale` with (the
 * row as it is now), or null for any other failure.
 */
export function staleSheetRow<T>(error: unknown): T | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as { data?: Record<string, unknown> }).data;
  const inner = (body?.data ?? body) as Record<string, unknown> | undefined;
  return inner?.reason === "control_sheet_stale" ? (inner.row as T) : null;
}

/**
 * Whether an amendment changes the form or the content, as «Tipo» in
 * «Enmiendas» reads it: «De forma» for a formal one, «De contenido» for
 * every other kind (CONTENT_AMENDMENT_KINDS).
 */
export function amendmentSheetKind(
  amendment: Pick<AmendmentDto, "kind">,
): "formal" | "content" {
  return amendment.kind === "formal" ? "formal" : "content";
}

/** One step of the agenda trail of a document, the root item first. */
export interface AgendaTrailStep {
  id: string;
  slug: string;
  number: string | null;
  title: string;
  /**
   * The document's own automatic sub-item, titled after it: shown by its
   * number alone, so the trail never repeats the document's title.
   */
  ownItem: boolean;
}

/**
 * Where a document hangs in the agenda: the item it hangs from and every
 * item above it, root first, numbered over the whole agenda as everywhere
 * else (numberAgendaItems). Empty when its item is not in the agenda the
 * reader gets.
 */
export function documentAgendaTrail(
  items: readonly AgendaItemDto[],
  document: Pick<DocumentSummaryDto, "id" | "agendaItemId">,
): AgendaTrailStep[] {
  const nodes = new Map(
    flattenAgendaTree(buildAgendaTree(items)).map((node) => [
      node.item.id,
      node,
    ]),
  );
  const trail: AgendaTrailStep[] = [];
  const seen = new Set<string>();
  let node = nodes.get(document.agendaItemId);
  while (node && !seen.has(node.item.id)) {
    seen.add(node.item.id);
    trail.unshift({
      id: node.item.id,
      slug: node.item.slug,
      number: node.number,
      title: node.item.title,
      ownItem: node.item.generatedForDocumentId === document.id,
    });
    node = node.parentId ? nodes.get(node.parentId) : undefined;
  }
  return trail;
}

/** The documents «Enmiendas» offers: those with amendments the reader sees. */
export function amendedDocuments(
  documents: readonly DocumentSummaryDto[],
  sheet: ControlSheetDto | null,
  ordered: readonly AgendaItemDto[],
): (DocumentSummaryDto & { amendments: number; undecided: number })[] {
  const counts = new Map(
    (sheet?.documents ?? []).map((document) => [document.id, document]),
  );
  const position = new Map(
    flattenAgendaTree(buildAgendaTree(ordered)).map((node, index) => [
      node.item.id,
      index,
    ]),
  );
  return documents
    .flatMap((document) => {
      const count = counts.get(document.id);
      if (!count || count.amendments === 0) return [];
      return [
        {
          ...document,
          amendments: count.amendments,
          undecided: count.undecided,
        },
      ];
    })
    .sort(
      (a, b) =>
        (position.get(a.agendaItemId) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(b.agendaItemId) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * Whether a batch of live events may change the sheet: anything recorded
 * but the Mesa moving what is on screen and the headcounts. "poll" (the
 * stream was down) always does.
 */
export function affectsControlSheet(
  events: readonly Pick<LiveEventDto, "type" | "entityType">[],
): boolean {
  return events.some(
    (event) =>
      event.type === "poll" ||
      (event.type !== "live_changed" && event.entityType !== "headcount"),
  );
}

/** Whether a batch of live events moved what the Mesa has on screen. */
export function affectsLiveDebate(
  events: readonly Pick<LiveEventDto, "type">[],
): boolean {
  return events.some(
    (event) => event.type === "poll" || event.type === "live_changed",
  );
}
