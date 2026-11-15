/**
 * Placing people in «Colocar» (docs/seating-plan.md, section 7): the tray
 * and its sections, what tapping a row or a seat picks, where a pick would
 * sit when it lands on a seat (and whether it fits, swaps or displaces
 * someone), the room after it lands, the seat ranges the live region reads
 * out, and «Lista». Pure, so it is unit-tested on its own (-placing.test.ts);
 * the page only sends what these work out through the assignments batch.
 *
 * The leading dash keeps Nuxt from registering this file as a component;
 * import it explicitly.
 */
import type { SeatingManualGroupKind } from "~~/shared/constants/domain";
import type {
  SeatingGroupDto,
  SeatingPersonDto,
  SeatingPlanDto,
} from "~~/shared/types/api";
import {
  SEATING_LEGEND_KINDS,
  comparePeople,
  groupSeatCounts,
  needsSeat,
  orderSeatingGroups,
  seatingGroupColour,
  seatingLegendKind,
  type GroupSeatCounts,
  type SeatAssignment,
  type SeatingColour,
  type SeatingLegendKind,
} from "~~/shared/utils/seating/groups";
import { blockSeats } from "~~/shared/utils/seating/placement";
import {
  compareWalk,
  seatLabelParts,
  seatPieces,
  type SeatingRunKind,
  type SeatingWalk,
  type WalkSeat,
} from "~~/shared/utils/seating/runs";
import { normalizeSearch, type SeatView, type SeatingPlanView } from "./-model";

type PlanParts = Pick<SeatingPlanDto, "groups" | "people" | "assignments">;

// The tray -----------------------------------------------------------------------

/**
 * The tray's sections: «Sin sentar», «En parte» and «Sentados» (folded).
 * A group with nobody left to seat (everyone seated, nobody who needs a
 * seat, or no longer registered) is in «Sentados»: nothing is left to do
 * with it, and it is still there to add people to.
 */
export const TRAY_SECTIONS = ["unseated", "partly", "seated"] as const;
export type TraySection = (typeof TRAY_SECTIONS)[number];

export interface TrayPerson {
  person: SeatingPersonDto;
  /** Where they sit, or null. */
  seatId: string | null;
  /** Needs a seat and is still registered (needsSeat). */
  counts: boolean;
}

export interface TrayGroup {
  group: SeatingGroupDto;
  /** What the legend counts it as, and so its colour. */
  kind: SeatingLegendKind;
  colour: SeatingColour;
  /** People who need a seat, seated and pending: the badge «2/3». */
  counts: GroupSeatCounts;
  section: TraySection;
  /** Its people in their order (comparePeople). */
  people: TrayPerson[];
  /** Who needs a seat and has none, in order: what picking the row places. */
  unseatedIds: string[];
  /** The search matched some of its people only: just they are listed. */
  narrowed: boolean;
}

export function traySection(counts: GroupSeatCounts): TraySection {
  if (counts.total === 0 || counts.seated >= counts.total) return "seated";
  return counts.seated === 0 ? "unseated" : "partly";
}

/** Every group in seating order (orderSeatingGroups), with its people. */
export function trayGroups(plan: PlanParts): TrayGroup[] {
  const counts = groupSeatCounts(plan.groups, plan.people, plan.assignments);
  const seatOf = new Map(
    plan.assignments.map((entry) => [entry.personId, entry.seatId]),
  );
  const peopleOf = new Map<string, SeatingPersonDto[]>();
  for (const person of plan.people) {
    const list = peopleOf.get(person.groupId) ?? [];
    list.push(person);
    peopleOf.set(person.groupId, list);
  }
  return orderSeatingGroups(plan.groups).map((group) => {
    const people = [...(peopleOf.get(group.id) ?? [])]
      .sort(comparePeople)
      .map((person) => ({
        person,
        seatId: seatOf.get(person.id) ?? null,
        counts: needsSeat(person, group),
      }));
    const groupCounts = counts.get(group.id) ?? {
      total: 0,
      seated: 0,
      pending: 0,
    };
    return {
      group,
      kind: seatingLegendKind(group),
      colour: seatingGroupColour(group),
      counts: groupCounts,
      section: traySection(groupCounts),
      people,
      unseatedIds: people
        .filter((entry) => entry.counts && !entry.seatId)
        .map((entry) => entry.person.id),
      narrowed: false,
    };
  });
}

export interface TrayFilter {
  /** Words that must all appear, accents and case aside. */
  query: string;
  /** One kind of the legend, or every kind. */
  kind: SeatingLegendKind | null;
}

function groupHaystack(group: SeatingGroupDto): string {
  return normalizeSearch(
    [
      group.acronym,
      group.name,
      group.member?.acronym,
      group.member?.name,
      group.member?.university,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function personHaystack(person: SeatingPersonDto): string {
  return normalizeSearch(
    [person.firstName, person.surname, person.label].filter(Boolean).join(" "),
  );
}

/**
 * The groups a search and a kind leave. A group whose own names match
 * keeps all its people; one that matches only through some of its people
 * lists just them (`narrowed`), so «Asistentes» opens it on them.
 */
export function filterTray(
  groups: readonly TrayGroup[],
  filter: TrayFilter,
): TrayGroup[] {
  const words = normalizeSearch(filter.query).split(" ").filter(Boolean);
  return groups.flatMap((entry) => {
    if (filter.kind && entry.kind !== filter.kind) return [];
    if (words.length === 0) return [entry];
    const own = groupHaystack(entry.group);
    if (words.every((word) => own.includes(word))) return [entry];
    const people = entry.people.filter((item) => {
      const haystack = `${own} ${personHaystack(item.person)}`;
      return words.every((word) => haystack.includes(word));
    });
    return people.length ? [{ ...entry, people, narrowed: true }] : [];
  });
}

/** The kinds the tray can be filtered by: those it has, in legend order. */
export function trayKinds(groups: readonly TrayGroup[]): SeatingLegendKind[] {
  const present = new Set(groups.map((entry) => entry.kind));
  return SEATING_LEGEND_KINDS.filter((kind) => present.has(kind));
}

/** The groups of each section, in seating order. */
export function traySections(
  groups: readonly TrayGroup[],
): Record<TraySection, TrayGroup[]> {
  const sections: Record<TraySection, TrayGroup[]> = {
    unseated: [],
    partly: [],
    seated: [],
  };
  for (const entry of groups) sections[entry.section].push(entry);
  return sections;
}

/** What «Añadir persona» asks for (PersonModal), before it is sent. */
export interface SeatingPersonDraft {
  /** An existing group, or a new one made by hand («Prensa»). */
  group:
    | { id: string }
    | { acronym: string; name: string; kind: SeatingManualGroupKind };
  firstName: string;
  surname: string | null;
  label: string | null;
  needsSeat: boolean;
  /** Link the person to the viewer's own account (the Mesa only). */
  linkMe: boolean;
}

// Picking ------------------------------------------------------------------------

/**
 * Who is being placed: picked in the tray (a group's people without a seat,
 * or one person) or on the plan (the block or the person on a seat, to move
 * it). Placing lands them on seats in this order.
 */
export interface SeatingPick {
  groupId: string;
  personIds: string[];
  /** «Intercambiar con…»: an occupied seat swaps without asking. */
  swap: boolean;
}

function walkPosition(walk: SeatingWalk, seatId: string): WalkSeat | null {
  return walk.seats.get(seatId) ?? null;
}

/** Seat ids in walk order; unknown ones last, by id. */
function sortSeats(walk: SeatingWalk, seatIds: Iterable<string>): string[] {
  return [...seatIds].sort((a, b) => {
    const left = walkPosition(walk, a);
    const right = walkPosition(walk, b);
    if (left && right) return compareWalk(left, right);
    if (left) return -1;
    if (right) return 1;
    return a.localeCompare(b);
  });
}

/**
 * What tapping a group's row picks: its people without a seat; with
 * everyone seated, all of them (in seat order) to move the whole account.
 * Null when there is nobody to place or move.
 */
export function trayPick(
  walk: SeatingWalk,
  entry: TrayGroup,
): SeatingPick | null {
  if (entry.unseatedIds.length) {
    return {
      groupId: entry.group.id,
      personIds: [...entry.unseatedIds],
      swap: false,
    };
  }
  const seated = entry.people.filter((item) => item.seatId);
  if (!seated.length) return null;
  const personBySeat = new Map(
    seated.map((item) => [item.seatId!, item.person.id]),
  );
  return {
    groupId: entry.group.id,
    personIds: sortSeats(walk, personBySeat.keys()).map((seatId) =>
      personBySeat.get(seatId)!,
    ),
    swap: false,
  };
}

/**
 * What tapping a person's row picks (Asistentes): that person, to place or
 * to move. Null for someone who neither needs a seat nor has one.
 */
export function personPick(item: TrayPerson): SeatingPick | null {
  if (!item.counts && !item.seatId) return null;
  return {
    groupId: item.person.groupId,
    personIds: [item.person.id],
    swap: false,
  };
}

/**
 * What tapping an occupied seat picks: in «Cuentas» the account's block
 * there (its people on seats together along the run, seatPieces: never cut
 * at a table's corner), in «Asistentes» the person. Null on an empty seat.
 */
export function unitAt(
  walk: SeatingWalk,
  plan: PlanParts,
  seatId: string,
  view: SeatingPlanView,
): SeatingPick | null {
  const occupantOf = new Map(
    plan.assignments.map((entry) => [entry.seatId, entry.personId]),
  );
  const personId = occupantOf.get(seatId);
  if (!personId) return null;
  const groupOf = new Map(
    plan.people.map((person) => [person.id, person.groupId]),
  );
  const groupId = groupOf.get(personId) ?? "";
  if (view === "people") return { groupId, personIds: [personId], swap: false };
  const own = plan.assignments
    .filter((entry) => groupOf.get(entry.personId) === groupId)
    .map((entry) => entry.seatId);
  const piece = seatPieces(walk, own).find((ids) => ids.includes(seatId)) ?? [
    seatId,
  ];
  return {
    groupId,
    personIds: piece.map((id) => occupantOf.get(id)!),
    swap: false,
  };
}

// Landing on a seat --------------------------------------------------------------

/** Where a pick would land on a seat, before anything is sent. */
export interface PlacementTarget {
  /**
   * The seats its people take, in walk order and in the pick's order;
   * fewer than its people when they do not all fit.
   */
  seatIds: string[];
  /** Whether everyone picked has a seat, all together. */
  fits: boolean;
  /** People on those seats who are not being placed (they must go). */
  displaced: string[];
  /**
   * The seat holds another block of the same size (one person in
   * «Asistentes»): the two swap places without asking.
   */
  swap: boolean;
}

/**
 * Where `pick` lands when it is dropped on `targetSeatId`:
 *
 * - On a free seat (or one of its own): the seats in a row from there,
 *   forwards along the run, never past someone else's seat; when the run
 *   or the free stretch ends first, the window of the same size that ends
 *   with it; when the stretch is too short, all of it (`fits` false: «Colocar
 *   los que caben»). Seats in a row: nothing ever lands on both sides of
 *   someone else. A loose chair takes one person.
 * - On someone else's seat: when the pick is seated already and the seat
 *   holds a block of the same size, the two swap; otherwise the seats from
 *   there whoever sits on them (blockSeats), and the page asks what to do
 *   with those people.
 *
 * Null for an unknown or disabled seat, or an empty pick.
 */
export function placementTarget(
  walk: SeatingWalk,
  plan: PlanParts,
  pick: SeatingPick,
  targetSeatId: string,
  view: SeatingPlanView,
): PlacementTarget | null {
  const target = walk.seats.get(targetSeatId);
  const count = pick.personIds.length;
  if (!target || target.disabled || count === 0) return null;
  const occupantOf = new Map(
    plan.assignments.map((entry) => [entry.seatId, entry.personId]),
  );
  const picked = new Set(pick.personIds);
  const ownSeats = new Set(
    plan.assignments
      .filter((entry) => picked.has(entry.personId))
      .map((entry) => entry.seatId),
  );
  const other = (seatId: string) => {
    const personId = occupantOf.get(seatId);
    return personId !== undefined && !picked.has(personId) ? personId : null;
  };
  const run = walk.runs[target.runIndex]!;

  if (other(target.id)) {
    const unit = unitAt(walk, plan, target.id, view);
    const unitSeats = unit
      ? sortSeats(
          walk,
          plan.assignments
            .filter((entry) => unit.personIds.includes(entry.personId))
            .map((entry) => entry.seatId),
        )
      : [];
    if (
      unit &&
      ownSeats.size === count &&
      unit.personIds.length === count &&
      unitSeats.every((seatId) => !ownSeats.has(seatId))
    ) {
      return {
        seatIds: unitSeats,
        fits: true,
        displaced: unitSeats.map((seatId) => occupantOf.get(seatId)!),
        swap: true,
      };
    }
    const block = blockSeats(walk, target.id, count);
    return {
      seatIds: block.seatIds,
      fits: block.fits,
      displaced: block.seatIds.flatMap((seatId) => {
        const personId = other(seatId);
        return personId ? [personId] : [];
      }),
      swap: false,
    };
  }

  if (run.kind === "loose") {
    return {
      seatIds: [target.id],
      fits: count === 1,
      displaced: [],
      swap: false,
    };
  }

  // The free stretch around the target: up to someone else's seat either
  // way; disabled seats are passed over and never taken.
  const seats = run.seats;
  const open = (seat: WalkSeat) => seat.disabled || !other(seat.id);
  let low = target.position;
  while (low > 0 && open(seats[low - 1]!)) low -= 1;
  let high = target.position;
  while (high < seats.length - 1 && open(seats[high + 1]!)) high += 1;
  const stretch = seats
    .slice(low, high + 1)
    .filter((seat) => !seat.disabled)
    .map((seat) => seat.id);
  const at = stretch.indexOf(target.id);
  const seatIds =
    stretch.length - at >= count
      ? stretch.slice(at, at + count)
      : stretch.length >= count
        ? stretch.slice(stretch.length - count)
        : stretch;
  return {
    seatIds,
    fits: seatIds.length === count,
    displaced: [],
    swap: false,
  };
}

/**
 * What to do with the people a placing finds on its seats:
 * - `swap` («Intercambiar»): they take the seats the pick leaves, in walk
 *   order; whoever does not fit there goes back to the tray;
 * - `displace` («Desplazar»): they go back to the tray.
 * Nobody is displaced on free seats; a target that `swap`s always swaps.
 */
export type PlacementChoice = "swap" | "displace";

export interface PlacementResult {
  /** The whole room after it, in walk order. */
  assignments: SeatAssignment[];
  /** The pick's people on their new seats, in walk order. */
  placed: SeatAssignment[];
  /** People displaced who took the seats the pick left. */
  moved: SeatAssignment[];
  /** People who had a seat and are left without one. */
  unseated: string[];
}

function sortedAssignments(
  walk: SeatingWalk,
  occupantOf: ReadonlyMap<string, string>,
): SeatAssignment[] {
  return sortSeats(walk, occupantOf.keys()).map((seatId) => ({
    seatId,
    personId: occupantOf.get(seatId)!,
  }));
}

function resultOf(
  walk: SeatingWalk,
  before: readonly SeatAssignment[],
  occupantOf: Map<string, string>,
  placed: SeatAssignment[],
  moved: SeatAssignment[],
): PlacementResult {
  const seatedAfter = new Set(occupantOf.values());
  return {
    assignments: sortedAssignments(walk, occupantOf),
    placed: sortedAssignments(
      walk,
      new Map(placed.map((entry) => [entry.seatId, entry.personId])),
    ),
    moved: sortedAssignments(
      walk,
      new Map(moved.map((entry) => [entry.seatId, entry.personId])),
    ),
    unseated: before
      .map((entry) => entry.personId)
      .filter((personId) => !seatedAfter.has(personId)),
  };
}

/**
 * The room once `pick` lands on `target`. The pick's people leave their
 * seats and take the target's in order; those beyond the seats it has
 * («Colocar los que caben») keep the seat they had, if still free, or stay
 * in the tray. The people displaced swap into the seats the pick left or go
 * to the tray, as `choice` says.
 */
export function applyPlacement(
  walk: SeatingWalk,
  assignments: readonly SeatAssignment[],
  pick: SeatingPick,
  target: PlacementTarget,
  choice: PlacementChoice = "displace",
): PlacementResult {
  const occupantOf = new Map(
    assignments.map((entry) => [entry.seatId, entry.personId]),
  );
  const seatOf = new Map(
    assignments.map((entry) => [entry.personId, entry.seatId]),
  );
  const picked = new Set(pick.personIds);
  const left = sortSeats(
    walk,
    pick.personIds.flatMap((personId) => {
      const seatId = seatOf.get(personId);
      return seatId ? [seatId] : [];
    }),
  );
  const displaced = target.seatIds.flatMap((seatId) => {
    const personId = occupantOf.get(seatId);
    return personId && !picked.has(personId) ? [personId] : [];
  });

  for (const seatId of left) occupantOf.delete(seatId);
  for (const seatId of target.seatIds) occupantOf.delete(seatId);

  const placed: SeatAssignment[] = [];
  target.seatIds.forEach((seatId, index) => {
    const personId = pick.personIds[index];
    if (!personId) return;
    occupantOf.set(seatId, personId);
    placed.push({ seatId, personId });
  });
  for (const personId of pick.personIds.slice(target.seatIds.length)) {
    const seatId = seatOf.get(personId);
    if (seatId && !occupantOf.has(seatId)) occupantOf.set(seatId, personId);
  }

  const moved: SeatAssignment[] = [];
  if (target.swap || choice === "swap") {
    const free = left.filter((seatId) => !occupantOf.has(seatId));
    displaced.forEach((personId, index) => {
      const seatId = free[index];
      if (!seatId) return;
      occupantOf.set(seatId, personId);
      moved.push({ seatId, personId });
    });
  }
  return resultOf(walk, assignments, occupantOf, placed, moved);
}

/** The room with these people back in the tray («Quitar»). */
export function unseatPeople(
  walk: SeatingWalk,
  assignments: readonly SeatAssignment[],
  personIds: readonly string[],
): PlacementResult {
  const gone = new Set(personIds);
  const occupantOf = new Map(
    assignments
      .filter((entry) => !gone.has(entry.personId))
      .map((entry) => [entry.seatId, entry.personId]),
  );
  return resultOf(walk, assignments, occupantOf, [], []);
}

/**
 * «Asignar…» in «Lista»: one seat gets one person (or nobody). Someone
 * already there swaps into the seat the person leaves, if they had one;
 * otherwise they go back to the tray.
 */
export function assignSeat(
  walk: SeatingWalk,
  assignments: readonly SeatAssignment[],
  seatId: string,
  personId: string | null,
): PlacementResult {
  const occupantOf = new Map(
    assignments.map((entry) => [entry.seatId, entry.personId]),
  );
  const current = occupantOf.get(seatId) ?? null;
  if (personId === null) {
    occupantOf.delete(seatId);
    return resultOf(walk, assignments, occupantOf, [], []);
  }
  if (current === personId) {
    return resultOf(walk, assignments, occupantOf, [], []);
  }
  const previous =
    assignments.find((entry) => entry.personId === personId)?.seatId ?? null;
  if (previous) occupantOf.delete(previous);
  occupantOf.set(seatId, personId);
  const moved: SeatAssignment[] = [];
  if (current && previous) {
    occupantOf.set(previous, current);
    moved.push({ seatId: previous, personId: current });
  }
  return resultOf(walk, assignments, occupantOf, [{ seatId, personId }], moved);
}

// Words for the live region ---------------------------------------------------------

/**
 * A stretch of seats in a row, for «los asientos 12 a 14 de la U exterior»:
 * the run's kind and ordinal (as seatLabelParts), and the first and last
 * seat numbers.
 */
export interface SeatRange {
  kind: SeatingRunKind;
  ordinal: number;
  from: number;
  to: number;
}

/** Seats as the stretches they make (seatPieces), in walk order. */
export function seatRanges(
  walk: SeatingWalk,
  seatIds: Iterable<string>,
): SeatRange[] {
  return seatPieces(walk, seatIds).flatMap((piece) => {
    const first = seatLabelParts(walk, piece[0]!);
    const last = seatLabelParts(walk, piece[piece.length - 1]!);
    if (!first || !last) return [];
    return [
      {
        kind: first.run.kind,
        ordinal: first.run.ordinal,
        from: first.number,
        to: last.number,
      },
    ];
  });
}

// «Lista» --------------------------------------------------------------------------

/** One table's seats (or the loose chairs), with its seat numbers. */
export interface ListTable {
  /** The table's id, or the run's for the loose chairs. */
  key: string;
  from: number;
  to: number;
  seats: SeatView[];
}

export interface ListRun {
  id: string;
  kind: SeatingRunKind;
  /** From 1 among the runs of its kind. */
  ordinal: number;
  tables: ListTable[];
}

/**
 * «Lista» by seats: each run (the Mesa, each U, the loose chairs) with its
 * tables in walk order, and each table with its seats.
 */
export function listRuns(
  walk: SeatingWalk,
  seats: readonly SeatView[],
): ListRun[] {
  const runs: ListRun[] = [];
  for (const seat of seats) {
    const at = walk.seats.get(seat.id);
    if (!at) continue;
    const parts = seatLabelParts(walk, seat.id)!;
    let run = runs[runs.length - 1];
    if (!run || run.id !== at.run) {
      run = {
        id: at.run,
        kind: parts.run.kind,
        ordinal: parts.run.ordinal,
        tables: [],
      };
      runs.push(run);
    }
    const key = at.tableId ?? at.run;
    let table = run.tables[run.tables.length - 1];
    if (!table || table.key !== key) {
      table = { key, from: parts.number, to: parts.number, seats: [] };
      run.tables.push(table);
    }
    table.to = parts.number;
    table.seats.push(seat);
  }
  return runs;
}
