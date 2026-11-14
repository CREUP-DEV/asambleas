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

import type {
  AgendaItemDto,
  AmendmentDto,
  ControlSheetAmendmentRowDto,
  ControlSheetDto,
  ControlSheetItemRowDto,
  DocumentSummaryDto,
  LiveEventDto,
  VoteDto,
} from "~~/shared/types/api";
import {
  amendmentTreatedInSession,
  controlSheetRows,
  itemDocumentsOutcome,
  itemOutcome,
  sheetSpeakers,
  type ItemOutcome,
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

/** A document as a row of «General» shows it. */
export interface SheetRowDocument {
  id: string;
  slug: string;
  title: string;
  status: DocumentSummaryDto["status"];
  voted: boolean;
  finalVote: VoteDto | null;
}

/** A row of «General». */
export interface GeneralSheetRow {
  id: string;
  /** `heading`: an item above listed ones, shown for its title only. */
  kind: "item" | "heading";
  number: string | null;
  unlisted: boolean;
  title: string;
  depth: number;
  documents: SheetRowDocument[];
  outcome: ItemOutcome;
  /** Treated by its documents' votes or results, whatever the Mesa marks. */
  autoTreated: boolean;
  speakers: SheetSpeaker[];
  /** What the sheet noted about it; null while nothing was. */
  sheet: ControlSheetItemRowDto | null;
  /** The Mesa has it in debate. */
  live: boolean;
}

/**
 * The rows of «General»: the items with documents past draft and the items
 * above them, numbered over the whole agenda (never over the rows shown),
 * with their documents' final votes and who spoke there.
 */
export function buildGeneralRows(
  items: readonly AgendaItemDto[],
  documents: readonly DocumentSummaryDto[],
  sheet: ControlSheetDto | null,
  liveItemId: string | null,
): GeneralSheetRow[] {
  const nodes = flattenAgendaTree(buildAgendaTree(items));
  const presented = documents.filter((document) => document.status !== "draft");
  const finalVotes = new Map(
    (sheet?.documents ?? []).map((document) => [
      document.id,
      document.finalVote,
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
    });
    documentsByItem.set(document.agendaItemId, list);
  }
  const turnsByItem = new Map<string, NonNullable<typeof sheet>["turns"]>();
  for (const turn of sheet?.turns ?? []) {
    if (!turn.agendaItemId) continue;
    const list = turnsByItem.get(turn.agendaItemId) ?? [];
    list.push(turn);
    turnsByItem.set(turn.agendaItemId, list);
  }
  const nodeById = new Map(nodes.map((node) => [node.item.id, node]));
  const notes = new Map(
    (sheet?.itemRows ?? []).map((row) => [row.agendaItemId, row]),
  );
  const listed = new Set(
    (sheet?.itemRows ?? [])
      .filter((row) => row.listed)
      .map((row) => row.agendaItemId),
  );
  const rows = controlSheetRows(
    nodes.map((node) => node.item),
    presented,
    listed,
  );
  return rows.map(({ item, kind }) => {
    const node = nodeById.get(item.id)!;
    const rowDocuments = documentsByItem.get(item.id) ?? [];
    const sheetDocuments = rowDocuments.map((document) => ({
      ...document,
      agendaItemId: item.id,
    }));
    const note = notes.get(item.id) ?? null;
    return {
      id: item.id,
      kind,
      number: node.number,
      unlisted: item.unlisted,
      title: item.title,
      depth: node.depth,
      documents: rowDocuments,
      outcome: itemOutcome(
        sheetDocuments,
        note
          ? { manualResult: note.manualResult, treated: note.treated !== null }
          : null,
      ),
      autoTreated: itemDocumentsOutcome(sheetDocuments).treated,
      speakers: sheetSpeakers(turnsByItem.get(item.id) ?? []),
      sheet: note,
      live: item.id === liveItemId,
    };
  });
}

/** A row of «Enmiendas». */
export interface AmendmentSheetRow {
  amendment: AmendmentDto;
  state: LiveAmendmentState;
  /** What the badge alone does not say (replaced by T1, incorporated...). */
  note: LiveAmendmentNote | null;
  treated: boolean;
  /** Treated because the Mesa settled it in session. */
  autoTreated: boolean;
  sheet: ControlSheetAmendmentRowDto | null;
  live: boolean;
}

/** The amendments of a document past draft, in the console's order. */
export function buildAmendmentRows(
  list: readonly AmendmentDto[],
  sessionStartedAt: string | null,
  liveAmendmentId: string | null,
  sheetRows: readonly ControlSheetAmendmentRowDto[] = [],
): AmendmentSheetRow[] {
  const notes = new Map(sheetRows.map((row) => [row.amendmentId, row]));
  const rows: LiveAmendmentRow[] = sortSessionAmendments(
    list.filter((amendment) => amendment.status !== "draft"),
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
      note: liveAmendmentNote(row, rows),
      treated: autoTreated || Boolean(sheet?.treated),
      autoTreated,
      sheet,
      live: row.current,
    };
  });
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
