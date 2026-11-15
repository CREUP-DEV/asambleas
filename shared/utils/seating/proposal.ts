import type { AssemblyType } from "../../constants/assemblyTypes";
import {
  comparePeople,
  isMesaOffice,
  MESA_OFFICE_ACRONYMS,
  needsSeat,
  orderSeatingGroups,
  seatingPlacementKind,
  type SeatAssignment,
  type SeatingGroupInput,
  type SeatingPersonInput,
} from "./groups";
import type { SeatingLayout, SeatingZone } from "./layout";
import {
  compareWalk,
  seatPieces,
  seatingWalk,
  type SeatingWalk,
  type WalkSeat,
} from "./runs";

/**
 * Proponer reparto (docs/seating-plan.md, section 7): a proposal the page
 * shows as a ghost to apply or discard. Pure and deterministic: the same
 * room, groups, people and seats always give the same proposal.
 *
 * 1. The Mesa: its group's people, then the CEA offices that sit at the
 *    Mesa at this type of assembly (MESA_OFFICE_ACRONYMS), on the
 *    `presiding` seats, centred along them. A Mesa person with no seat
 *    left there stays without one; an office goes with the CEA.
 * 2. The people missing from a group already seated in part (only when
 *    filling empty seats): next to their group, on the free seats right
 *    after or before it along its run, in its zone.
 * 3. The CEA, in the Intranet's order, on the `cea` seats; what does not
 *    fit goes on along the same run, up the arms next to the CEA's base.
 * 4. The asociados in the order of the roll call, then the sectoriales, then
 *    the CAS (CAS_SITS_WITH: never in the `cea` zone), then everyone else,
 *    on the `delegates` seats, run after run (the outer U, then the inner
 *    U).
 *
 * A group is placed whole on a stretch of seats in a row: one run, one
 * zone, nothing occupied between them (disabled seats are passed over). A
 * group that does not fit the rest of its stretch goes on to the next
 * stretch it fits, in order; the groups that fit nowhere then fill what is
 * left, the largest first, and are split only when no stretch can hold
 * them. Every split is listed, and so is everyone left without a seat.
 * `free` tables and loose chairs are never filled: they are for placing by
 * hand. Nobody who does not need a seat, or is no longer registered, is
 * placed.
 */

export type SeatingProposalMode = "fillEmpty" | "redoAll";

export interface SeatingProposalInput {
  layout: SeatingLayout;
  groups: readonly SeatingGroupInput[];
  people: readonly SeatingPersonInput[];
  /** The room as it is. `redoAll` ignores it. */
  assignments: readonly SeatAssignment[];
  assemblyType: AssemblyType;
  /** `fillEmpty` keeps everyone seated and fills empty seats only. */
  mode: SeatingProposalMode;
}

/** A group whose seats are not all together: the size of each piece. */
export interface SeatingSplit {
  groupId: string;
  pieces: number[];
}

export interface SeatingUnseated {
  groupId: string;
  personIds: string[];
}

export interface SeatingProposal {
  /** The whole room after the proposal, in walk order. */
  assignments: SeatAssignment[];
  /** What the proposal adds or moves (the ghost), in walk order. */
  placed: SeatAssignment[];
  /** Every group whose seats come in more than one piece, in seating order. */
  splits: SeatingSplit[];
  /** People who need a seat and get none, by group in seating order. */
  unseated: SeatingUnseated[];
}

/** One change of a seat for POST .../seating/assignments. */
export interface SeatingAssignmentOp {
  seatId: string;
  /** Who the client saw there (null: empty). */
  expected: string | null;
  /** Who sits there after (null: nobody). */
  next: string | null;
}

/**
 * The batch that turns the room `current` into `next`: one op per seat whose
 * occupant changes, by seat id.
 */
export function assignmentOps(
  current: readonly SeatAssignment[],
  next: readonly SeatAssignment[],
): SeatingAssignmentOp[] {
  const before = new Map(
    current.map((entry) => [entry.seatId, entry.personId]),
  );
  const after = new Map(next.map((entry) => [entry.seatId, entry.personId]));
  const seatIds = [...new Set([...before.keys(), ...after.keys()])].sort();
  return seatIds.flatMap((seatId) => {
    const expected = before.get(seatId) ?? null;
    const following = after.get(seatId) ?? null;
    return expected === following
      ? []
      : [{ seatId, expected, next: following }];
  });
}

interface Block {
  groupId: string;
  personIds: string[];
}

/** A stretch of free seats in a row, filled from its start. */
interface Stretch {
  seatIds: string[];
  next: number;
}

const remaining = (stretch: Stretch) => stretch.seatIds.length - stretch.next;

class Room {
  readonly seatOf = new Map<string, string>();
  readonly occupantOf = new Map<string, string>();
  readonly placed: SeatAssignment[] = [];

  constructor(readonly walk: SeatingWalk) {}

  isFree(seat: WalkSeat): boolean {
    return !seat.disabled && !this.occupantOf.has(seat.id);
  }

  seat(seatId: string, personId: string, proposed: boolean): void {
    this.seatOf.set(personId, seatId);
    this.occupantOf.set(seatId, personId);
    if (proposed) this.placed.push({ seatId, personId });
  }

  /**
   * The stretches of free seats of one zone: along each run, cut wherever
   * the zone changes or a seat is taken. Disabled seats do not cut.
   */
  stretches(zone: SeatingZone): Stretch[] {
    const stretches: Stretch[] = [];
    for (const run of this.walk.runs) {
      if (run.kind === "loose") continue;
      let current: string[] = [];
      const close = () => {
        if (current.length) stretches.push({ seatIds: current, next: 0 });
        current = [];
      };
      for (const seat of run.seats) {
        if (seat.zone !== zone) close();
        else if (seat.disabled) continue;
        else if (this.occupantOf.has(seat.id)) close();
        else current.push(seat.id);
      }
      close();
    }
    return stretches;
  }

  /**
   * The free seats of `zone` next to a stretch of `from` (another zone, the
   * CEA's) along the same run: first those after it, in walk order, then
   * those before it, walking back. Each side is a stretch of its own.
   */
  stretchesBeside(from: SeatingZone, zone: SeatingZone): Stretch[] {
    const stretches: Stretch[] = [];
    for (const run of this.walk.runs) {
      if (run.kind === "loose") continue;
      const seats = run.seats;
      const first = seats.findIndex((seat) => seat.zone === from);
      if (first === -1) continue;
      let last = first;
      for (let index = first; index < seats.length; index += 1) {
        if (seats[index]!.zone === from) last = index;
      }
      const collect = (start: number, step: 1 | -1) => {
        const ids: string[] = [];
        for (
          let index = start;
          index >= 0 && index < seats.length;
          index += step
        ) {
          const seat = seats[index]!;
          if (seat.zone !== zone) break;
          if (seat.disabled) continue;
          if (this.occupantOf.has(seat.id)) break;
          ids.push(seat.id);
        }
        if (ids.length) stretches.push({ seatIds: ids, next: 0 });
      };
      collect(last + 1, 1);
      collect(first - 1, -1);
    }
    return stretches;
  }

  /**
   * Places blocks on stretches, in order: each whole on the first stretch
   * from the current one on where it fits, the rest of a stretch it skips
   * left for later. Returns the blocks that fit nowhere that way.
   */
  placeInOrder(blocks: readonly Block[], stretches: Stretch[]): Block[] {
    const deferred: Block[] = [];
    let cursor = 0;
    for (const block of blocks) {
      const size = block.personIds.length;
      if (!size) continue;
      let found = -1;
      for (let index = cursor; index < stretches.length; index += 1) {
        if (remaining(stretches[index]!) >= size) {
          found = index;
          break;
        }
      }
      if (found === -1) {
        deferred.push(block);
        continue;
      }
      cursor = found;
      this.fill(block.personIds, stretches[found]!);
    }
    return deferred;
  }

  /**
   * Places blocks on what the stretches have left, the largest first: whole
   * on the first stretch that holds it, else split over the largest
   * stretches left. Returns the people left without a seat.
   */
  fillLeft(blocks: readonly Block[], stretches: Stretch[]): Block[] {
    const left: Block[] = [];
    const bySize = blocks
      .map((block, order) => ({ block, order }))
      .sort(
        (a, b) =>
          b.block.personIds.length - a.block.personIds.length ||
          a.order - b.order,
      );
    for (const { block } of bySize) {
      const size = block.personIds.length;
      if (!size) continue;
      const whole = stretches.find((stretch) => remaining(stretch) >= size);
      if (whole) {
        this.fill(block.personIds, whole);
        continue;
      }
      const largest = stretches
        .map((stretch, order) => ({ stretch, order }))
        .filter(({ stretch }) => remaining(stretch) > 0)
        .sort(
          (a, b) =>
            remaining(b.stretch) - remaining(a.stretch) || a.order - b.order,
        );
      let people = block.personIds;
      for (const { stretch } of largest) {
        if (!people.length) break;
        const taken = Math.min(remaining(stretch), people.length);
        this.fill(people.slice(0, taken), stretch);
        people = people.slice(taken);
      }
      if (people.length)
        left.push({ groupId: block.groupId, personIds: people });
    }
    return left;
  }

  private fill(personIds: readonly string[], stretch: Stretch): void {
    for (const personId of personIds) {
      this.seat(stretch.seatIds[stretch.next]!, personId, true);
      stretch.next += 1;
    }
  }

  /**
   * Seats a group's missing people right after its seats along the run, then
   * right before them, while the seats are free and in the zone of the seat
   * they follow. Returns who is still without a seat.
   */
  extend(groupSeatIds: readonly string[], personIds: string[]): string[] {
    const seats = groupSeatIds
      .map((id) => this.walk.seats.get(id))
      .filter(
        (seat): seat is WalkSeat => seat !== undefined && seat.zone !== null,
      )
      .sort(compareWalk);
    if (!seats.length) return personIds;
    let people = personIds;
    const walkFrom = (edge: WalkSeat, step: 1 | -1) => {
      const run = this.walk.runs[edge.runIndex]!.seats;
      for (
        let position = edge.position + step;
        people.length && position >= 0 && position < run.length;
        position += step
      ) {
        const seat = run[position]!;
        if (seat.zone !== edge.zone) break;
        if (seat.disabled) continue;
        if (!this.isFree(seat)) break;
        this.seat(seat.id, people[0]!, true);
        people = people.slice(1);
      }
    };
    walkFrom(seats[seats.length - 1]!, 1);
    walkFrom(seats[0]!, -1);
    return people;
  }
}

/** Takes `count` seats from the middle of `seatIds`. */
function centred(seatIds: readonly string[], count: number): string[] {
  const start = Math.max(0, Math.floor((seatIds.length - count) / 2));
  return seatIds.slice(start, start + count);
}

export function proposeSeating(input: SeatingProposalInput): SeatingProposal {
  const walk = seatingWalk(input.layout);
  const room = new Room(walk);
  const groups = orderSeatingGroups(input.groups);
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const peopleOf = new Map<string, SeatingPersonInput[]>();
  for (const person of [...input.people].sort(comparePeople)) {
    if (!groupById.has(person.groupId)) continue;
    const list = peopleOf.get(person.groupId) ?? [];
    list.push(person);
    peopleOf.set(person.groupId, list);
  }
  const knownPeople = new Set(
    [...peopleOf.values()].flat().map((person) => person.id),
  );

  // The room as it is, when only empty seats are filled: seats that still
  // take people, people that still exist, each once, in walk order.
  if (input.mode === "fillEmpty") {
    const kept = input.assignments
      .map((entry) => ({ entry, seat: walk.seats.get(entry.seatId) }))
      .filter(
        (item): item is { entry: SeatAssignment; seat: WalkSeat } =>
          item.seat !== undefined &&
          !item.seat.disabled &&
          knownPeople.has(item.entry.personId),
      )
      .sort((a, b) => compareWalk(a.seat, b.seat));
    for (const { entry } of kept) {
      if (
        room.seatOf.has(entry.personId) ||
        room.occupantOf.has(entry.seatId)
      ) {
        continue;
      }
      room.seat(entry.seatId, entry.personId, false);
    }
  }

  const waiting = (groupId: string) =>
    (peopleOf.get(groupId) ?? [])
      .filter(
        (person) =>
          needsSeat(person, groupById.get(groupId)) &&
          !room.seatOf.has(person.id),
      )
      .map((person) => person.id);

  const unseated: Block[] = [];

  // 1. The Mesa.
  const mesaGroups = groups.filter((group) => group.kind === "mesa");
  const offices = groups
    .filter((group) => isMesaOffice(group, input.assemblyType))
    .sort(
      (a, b) =>
        officeRank(a, input.assemblyType) - officeRank(b, input.assemblyType),
    );
  const mesaPeople: Block[] = [
    ...mesaGroups.map((group) => ({
      groupId: group.id,
      personIds: waiting(group.id),
    })),
    ...offices.map((group) => ({
      groupId: group.id,
      personIds: waiting(group.id),
    })),
  ].filter((block) => block.personIds.length);
  const presiding = walkSeatsOf(walk, "presiding").filter((seat) =>
    room.isFree(seat),
  );
  const mesaCount = mesaPeople.reduce(
    (sum, block) => sum + block.personIds.length,
    0,
  );
  const mesaSeats = centred(
    presiding.map((seat) => seat.id),
    mesaCount,
  );
  let mesaIndex = 0;
  for (const block of mesaPeople) {
    const left: string[] = [];
    for (const personId of block.personIds) {
      const seatId = mesaSeats[mesaIndex];
      if (seatId) {
        room.seat(seatId, personId, true);
        mesaIndex += 1;
      } else left.push(personId);
    }
    const group = groupById.get(block.groupId)!;
    if (left.length && group.kind === "mesa") {
      unseated.push({ groupId: block.groupId, personIds: left });
    }
  }

  // 2. Groups already seated in part, next to their people.
  if (input.mode === "fillEmpty") {
    for (const group of groups) {
      if (group.kind === "mesa") continue;
      const people = waiting(group.id);
      if (!people.length) continue;
      const seated = (peopleOf.get(group.id) ?? []).flatMap((person) => {
        const seatId = room.seatOf.get(person.id);
        return seatId ? [seatId] : [];
      });
      if (seated.length) room.extend(seated, people);
    }
  }

  const blocksOf = (selected: readonly SeatingGroupInput[]): Block[] =>
    selected
      .map((group) => ({ groupId: group.id, personIds: waiting(group.id) }))
      .filter((block) => block.personIds.length);

  // 3. The CEA (and whoever sits with it).
  const ceaBlocks = blocksOf(
    groups.filter((group) => seatingPlacementKind(group) === "cea"),
  );
  const ceaStretches = room.stretches("cea");
  let ceaLeft = room.placeInOrder(ceaBlocks, ceaStretches);
  ceaLeft = room.fillLeft(ceaLeft, ceaStretches);
  if (ceaLeft.length) {
    const beside = room.stretchesBeside("cea", "delegates");
    ceaLeft = room.placeInOrder(ceaLeft, beside);
    ceaLeft = room.fillLeft(ceaLeft, beside);
  }

  // 4. The delegations (the CAS among them, right after the sectoriales:
  // `groups` is in that order), then the CEA that found no seat by its own.
  const delegateBlocks = blocksOf(
    groups.filter((group) => {
      const kind = seatingPlacementKind(group);
      return kind === "asociado" || kind === "sectorial" || kind === "other";
    }),
  );
  const delegateStretches = room.stretches("delegates");
  const deferred = room.placeInOrder(delegateBlocks, delegateStretches);
  unseated.push(...room.fillLeft([...deferred, ...ceaLeft], delegateStretches));

  // The result.
  const assignments = [...room.occupantOf.entries()]
    .map(([seatId, personId]) => ({ seatId, personId }))
    .sort((a, b) =>
      compareWalk(walk.seats.get(a.seatId)!, walk.seats.get(b.seatId)!),
    );
  const placed = [...room.placed].sort((a, b) =>
    compareWalk(walk.seats.get(a.seatId)!, walk.seats.get(b.seatId)!),
  );
  const splits: SeatingSplit[] = [];
  for (const group of groups) {
    const seatIds = (peopleOf.get(group.id) ?? []).flatMap((person) => {
      const seatId = room.seatOf.get(person.id);
      return seatId ? [seatId] : [];
    });
    const pieces = seatPieces(walk, seatIds);
    if (pieces.length > 1) {
      splits.push({
        groupId: group.id,
        pieces: pieces.map((piece) => piece.length),
      });
    }
  }
  const unseatedByGroup = new Map<string, string[]>();
  for (const block of unseated) {
    unseatedByGroup.set(block.groupId, [
      ...(unseatedByGroup.get(block.groupId) ?? []),
      ...block.personIds,
    ]);
  }
  return {
    assignments,
    placed,
    splits,
    unseated: groups.flatMap((group) => {
      const personIds = unseatedByGroup.get(group.id);
      if (!personIds) return [];
      const order = new Map(
        (peopleOf.get(group.id) ?? []).map((person, index) => [
          person.id,
          index,
        ]),
      );
      return [
        {
          groupId: group.id,
          personIds: [...personIds].sort(
            (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
          ),
        },
      ];
    }),
  };
}

/** An office's place at the Mesa's table (MESA_OFFICE_ACRONYMS order). */
function officeRank(group: SeatingGroupInput, type: AssemblyType): number {
  return MESA_OFFICE_ACRONYMS[type].indexOf(group.acronym.trim().toUpperCase());
}

/** The seats of one zone in walk order. */
function walkSeatsOf(walk: SeatingWalk, zone: SeatingZone): WalkSeat[] {
  return walk.runs.flatMap((run) =>
    run.seats.filter((seat) => seat.zone === zone),
  );
}
