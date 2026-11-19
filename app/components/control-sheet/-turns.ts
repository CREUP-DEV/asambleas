/**
 * «Turnos de palabra», the control sheet's fourth tab: every turn that took
 * the floor in the assembly (ControlSheetDto.turns, in the order they did),
 * how long each lasted, and the totals per member. Pure, so it is tested
 * on its own; the component words it.
 *
 * Kept with a `-` prefix so Nuxt does not register it as a component
 * (`ignorePrefix`); import it explicitly.
 */

import type {
  AgendaItemDto,
  MemberRef,
  SpeakingTurnDto,
} from "~~/shared/types/api";
import { buildAgendaTree, flattenAgendaTree } from "~/utils/agendaTree";
import { sessionElapsedSeconds } from "~/composables/session/sessionModel";

/** The agenda item a turn was given in, as the sheet names it. */
export interface TurnItem {
  id: string;
  number: string | null;
  title: string;
  titleHidden: boolean;
}

/** One turn as a row of the list. */
export interface TurnRow {
  turn: SpeakingTurnDto;
  /** 1 for the first turn of the assembly, counted before any filter. */
  index: number;
  /** Null for a turn given while no agenda item was in debate. */
  item: TurnItem | null;
  /** Whom it counts for in the totals and the filter (turnWhoKey). */
  whoKey: string;
  /** How long it lasted; null while it still has the floor. */
  seconds: number | null;
  speaking: boolean;
}

/** One member's (or person's) turns, for «Por interviniente». */
export interface TurnTotal {
  whoKey: string;
  member: MemberRef | null;
  /** The name written down, only for turns of nobody's member. */
  speaker: string | null;
  turns: number;
  /** Every turn's seconds, the one with the floor counted up to `now`. */
  seconds: number;
  speaking: boolean;
}

/** The two ways the tab shows the turns. */
export const TURN_VIEWS = ["list", "totals"] as const;
export type TurnView = (typeof TURN_VIEWS)[number];

/** The item filter's value for turns given with no item in debate. */
export const NO_ITEM = "none";

/**
 * Whom a turn counts for: its member, else the name written down (case and
 * spaces aside), else nobody named.
 */
export function turnWhoKey(
  turn: Pick<SpeakingTurnDto, "member" | "speaker">,
): string {
  if (turn.member) return `member:${turn.member.id}`;
  const speaker = turn.speaker?.trim().toLocaleLowerCase("es") ?? "";
  return speaker ? `speaker:${speaker}` : "unnamed";
}

function timeOf(value: string | null): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** The items of the agenda, numbered as everywhere, in its order. */
export function turnItems(
  items: readonly AgendaItemDto[],
): Map<string, TurnItem> {
  return new Map(
    flattenAgendaTree(buildAgendaTree(items)).map((node) => [
      node.item.id,
      {
        id: node.item.id,
        number: node.number,
        title: node.item.title,
        titleHidden: node.item.titleHidden === true,
      },
    ]),
  );
}

/**
 * The rows of the list, in the order the turns took the floor. A turn
 * whose item the reader does not get stays, under no item: the server
 * already leaves out the turns of items the reader may not read.
 */
export function buildTurnRows(
  turns: readonly SpeakingTurnDto[],
  items: ReadonlyMap<string, TurnItem>,
): TurnRow[] {
  return (
    turns
      // Noted by hand: who spoke, never a turn with a time («Intervinientes»).
      .filter(
        (turn) =>
          !turn.noted && (turn.status === "speaking" || turn.status === "done"),
      )
      .map((turn, index) => {
        const speaking = turn.status === "speaking";
        return {
          turn,
          index: index + 1,
          item: turn.agendaItemId
            ? (items.get(turn.agendaItemId) ?? null)
            : null,
          whoKey: turnWhoKey(turn),
          seconds:
            speaking || !turn.startedAt
              ? null
              : sessionElapsedSeconds(turn.startedAt, timeOf(turn.endedAt)),
          speaking,
        };
      })
  );
}

export interface TurnFilters {
  /** An agenda item id, NO_ITEM, or null for every item. */
  itemId: string | null;
  /** A turnWhoKey, or null for everyone. */
  whoKey: string | null;
}

export function filterTurnRows(
  rows: readonly TurnRow[],
  filters: TurnFilters,
): TurnRow[] {
  return rows.filter(
    (row) =>
      (filters.itemId === null ||
        (filters.itemId === NO_ITEM
          ? row.item === null
          : row.item?.id === filters.itemId)) &&
      (filters.whoKey === null || row.whoKey === filters.whoKey),
  );
}

/** A row's seconds, the turn with the floor counted up to `now`. */
export function turnRowSeconds(row: TurnRow, now: number): number {
  if (row.seconds !== null) return row.seconds;
  return row.turn.startedAt
    ? sessionElapsedSeconds(row.turn.startedAt, now)
    : 0;
}

/** Every row's seconds together. */
export function totalTurnSeconds(
  rows: readonly TurnRow[],
  now: number,
): number {
  return rows.reduce((sum, row) => sum + turnRowSeconds(row, now), 0);
}

/**
 * The totals per member (or person), longest first; ties by number of
 * turns, then by who spoke first.
 */
export function turnTotals(rows: readonly TurnRow[], now: number): TurnTotal[] {
  const totals = new Map<string, TurnTotal & { first: number }>();
  for (const row of rows) {
    const seconds = turnRowSeconds(row, now);
    const total = totals.get(row.whoKey);
    if (total) {
      total.turns += 1;
      total.seconds += seconds;
      total.speaking ||= row.speaking;
      continue;
    }
    totals.set(row.whoKey, {
      whoKey: row.whoKey,
      member: row.turn.member,
      speaker: row.turn.member ? null : row.turn.speaker?.trim() || null,
      turns: 1,
      seconds,
      speaking: row.speaking,
      first: row.index,
    });
  }
  return [...totals.values()]
    .sort(
      (a, b) => b.seconds - a.seconds || b.turns - a.turns || a.first - b.first,
    )
    .map(({ first: _first, ...total }) => total);
}

/**
 * The items the filter offers: those with turns, in the order of the
 * agenda, and «no item» last when a turn had none.
 */
export function turnItemOptions(
  rows: readonly TurnRow[],
  items: ReadonlyMap<string, TurnItem>,
): { items: TurnItem[]; none: boolean } {
  const used = new Set(rows.map((row) => row.item?.id ?? null));
  return {
    items: [...items.values()].filter((item) => used.has(item.id)),
    none: used.has(null),
  };
}

/** The people the filter offers, once each, in the order they first spoke. */
export function turnWhoOptions(
  rows: readonly TurnRow[],
): Pick<TurnRow, "whoKey" | "turn">[] {
  const seen = new Set<string>();
  const options: Pick<TurnRow, "whoKey" | "turn">[] = [];
  for (const row of rows) {
    if (seen.has(row.whoKey)) continue;
    seen.add(row.whoKey);
    options.push({ whoKey: row.whoKey, turn: row.turn });
  }
  return options;
}
