import {
  needsSeat,
  orderSeatingGroups,
  type SeatAssignment,
  type SeatingGroupInput,
  type SeatingPersonInput,
} from "./groups";
import {
  enabledSeatIds,
  layoutSeatIds,
  seatsLostByEdit,
  type SeatingLayout,
} from "./layout";
import { seatPieces, seatingWalk } from "./runs";

/**
 * The warnings panel of «Colocar» (docs/seating-plan.md, section 7): what
 * the room still lacks or got wrong. Pure; the client words each kind.
 */
export type SeatingWarning =
  /** An edit of the room takes seats someone holds (seats and occupants). */
  | { kind: "seats_lost"; seatIds: string[]; personIds: string[] }
  /** More people who need a seat than seats that take people. */
  | { kind: "seats_short"; seats: number; people: number }
  /** A group with nobody seated. */
  | { kind: "group_unseated"; groupId: string; total: number }
  /** A group seated in part. */
  | {
      kind: "group_partly_seated";
      groupId: string;
      seated: number;
      total: number;
    }
  /** A group whose seats are not all together: the size of each piece. */
  | { kind: "group_split"; groupId: string; pieces: number[] }
  /** Someone the Intranet no longer lists, still on a seat. */
  | { kind: "gone_seated"; groupId: string; personId: string; seatId: string }
  /** More seats than people who need one. */
  | { kind: "seats_spare"; seats: number; people: number };

export type SeatingWarningKind = SeatingWarning["kind"];

export interface SeatingWarningsInput {
  /** The room, or the draft being edited. */
  layout: SeatingLayout;
  /** The room as saved, when `layout` is a draft: its lost seats are warned of. */
  savedLayout?: SeatingLayout | null;
  groups: readonly SeatingGroupInput[];
  people: readonly SeatingPersonInput[];
  assignments: readonly SeatAssignment[];
}

/**
 * Every warning, in this order: seats lost by the edit, not enough seats,
 * groups not seated, seated in part, split, people no longer registered on
 * a seat, spare seats. Groups come in seating order (orderSeatingGroups).
 */
export function seatingWarnings(input: SeatingWarningsInput): SeatingWarning[] {
  const saved = input.savedLayout ?? input.layout;
  const walk = seatingWalk(saved);
  const savedSeats = new Set(layoutSeatIds(saved));
  const assignments = input.assignments.filter((entry) =>
    savedSeats.has(entry.seatId),
  );
  const seatOf = new Map(
    assignments.map((entry) => [entry.personId, entry.seatId]),
  );
  const groups = orderSeatingGroups(input.groups);
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const peopleOf = new Map<string, SeatingPersonInput[]>();
  for (const person of input.people) {
    if (!groupById.has(person.groupId)) continue;
    peopleOf.set(person.groupId, [
      ...(peopleOf.get(person.groupId) ?? []),
      person,
    ]);
  }

  const warnings: SeatingWarning[] = [];

  if (input.savedLayout) {
    const lost = new Set(seatsLostByEdit(input.savedLayout, input.layout));
    const held = assignments.filter((entry) => lost.has(entry.seatId));
    if (held.length) {
      warnings.push({
        kind: "seats_lost",
        seatIds: held.map((entry) => entry.seatId),
        personIds: held.map((entry) => entry.personId),
      });
    }
  }

  const seats = enabledSeatIds(input.layout).size;
  const people = input.people.filter((person) =>
    needsSeat(person, groupById.get(person.groupId)),
  ).length;
  if (people > seats) warnings.push({ kind: "seats_short", seats, people });

  const unseated: SeatingWarning[] = [];
  const partly: SeatingWarning[] = [];
  const split: SeatingWarning[] = [];
  const gone: SeatingWarning[] = [];
  for (const group of groups) {
    const members = peopleOf.get(group.id) ?? [];
    const counted = members.filter((person) => needsSeat(person, group));
    const seated = counted.filter((person) => seatOf.has(person.id)).length;
    if (counted.length && !seated) {
      unseated.push({
        kind: "group_unseated",
        groupId: group.id,
        total: counted.length,
      });
    } else if (seated < counted.length) {
      partly.push({
        kind: "group_partly_seated",
        groupId: group.id,
        seated,
        total: counted.length,
      });
    }
    const pieces = seatPieces(
      walk,
      members.flatMap((person) => {
        const seatId = seatOf.get(person.id);
        return seatId ? [seatId] : [];
      }),
    );
    if (pieces.length > 1) {
      split.push({
        kind: "group_split",
        groupId: group.id,
        pieces: pieces.map((piece) => piece.length),
      });
    }
    for (const person of members) {
      const seatId = seatOf.get(person.id);
      if (seatId && (person.goneAt || group.goneAt)) {
        gone.push({
          kind: "gone_seated",
          groupId: group.id,
          personId: person.id,
          seatId,
        });
      }
    }
  }
  warnings.push(...unseated, ...partly, ...split, ...gone);

  if (seats > people) warnings.push({ kind: "seats_spare", seats, people });
  return warnings;
}
