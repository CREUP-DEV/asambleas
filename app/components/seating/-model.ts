/**
 * What the seating plan draws (docs/seating-plan.md, section 7), worked out
 * from the SeatingPlanDto: each seat with its occupant, the account blocks
 * of «Cuentas», the colours, initials, the «¿Dónde está…?» search, where a
 * new loose chair goes, and the regeneration of a room being edited. Pure,
 * so it is unit-tested on its own (-model.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component;
 * import it explicitly.
 */
import type {
  SeatingGroupDto,
  SeatingPersonDto,
  SeatingPlanDto,
} from "~~/shared/types/api";
import {
  SEATING_SEAT_DIAMETER,
  SEATING_SEAT_OFFSET,
  normalizeRotation,
  type DoubleUParams,
  seatPoints,
  type SeatingLayout,
  type SeatingSeat,
  type SeatingTable,
  type SeatingTemplate,
} from "~~/shared/utils/seating/layout";
import {
  seatPieces,
  walkOrder,
  type SeatingRunKind,
  type SeatingWalk,
} from "~~/shared/utils/seating/runs";
import {
  seatingGroupColour,
  type SeatingColour,
} from "~~/shared/utils/seating/groups";
import {
  DOUBLE_U_LIMITS,
  doubleUParamsProblem,
  regenerateSeatingLayout,
} from "~~/shared/utils/seating/templates";

// The plan's states -------------------------------------------------------------

/** «Cuentas» (one block per account) or «Asistentes» (one bubble per seat). */
export type SeatingPlanView = "accounts" | "people";

/** «Ver», «Colocar» (the tray, placing by pick and tap) and «Editar sala». */
export type SeatingPlanMode = "view" | "place" | "edit";

/**
 * The seats a placing would take (placementTarget), drawn green when the
 * whole pick fits together and red when not, and the seats of the people it
 * would move or send back to the tray, drawn dashed. The overlay says it in
 * words too: never by colour alone.
 */
export interface SeatingPlanPreview {
  seatIds: readonly string[];
  fits: boolean;
  displacedSeatIds?: readonly string[];
}

// Colours ----------------------------------------------------------------------

/**
 * The place cards' colours as CSS values, one static map so Tailwind never
 * needs a class built at run time. The ring is the colour itself (3:1 or
 * more on the floor in both themes); the tint is opaque, mixed into the
 * page's background, so a capsule drawn as two strokes never shows the
 * outer one through the inner one. Text stays neutral (AGENTS.md).
 */
export const SEATING_COLOUR_STYLES: Record<
  SeatingColour,
  { ring: string; tint: string }
> = {
  primary: {
    ring: "var(--ui-primary)",
    tint: "color-mix(in oklab, var(--ui-primary) 14%, var(--ui-bg))",
  },
  info: {
    ring: "var(--ui-info)",
    tint: "color-mix(in oklab, var(--ui-info) 14%, var(--ui-bg))",
  },
  sectorial: {
    ring: "var(--ui-sectorial)",
    tint: "color-mix(in oklab, var(--ui-sectorial) 14%, var(--ui-bg))",
  },
  // CREUP's beige (main.css): a tan ring and a pale beige tint.
  beige: {
    ring: "var(--seating-beige)",
    tint: "color-mix(in oklab, var(--seating-beige) 18%, var(--ui-bg))",
  },
  neutral: {
    ring: "var(--ui-text-dimmed)",
    tint: "color-mix(in oklab, var(--ui-text-dimmed) 12%, var(--ui-bg))",
  },
};

// Seats ------------------------------------------------------------------------

export interface SeatOccupant {
  person: SeatingPersonDto;
  /** Null only if the plan lost the person's group (never in practice). */
  group: SeatingGroupDto | null;
  colour: SeatingColour;
}

/** A seat as the plan draws it, in walk order. */
export interface SeatView {
  id: string;
  x: number;
  y: number;
  /** Where its occupant looks: clockwise, 0 up the page. */
  facing: number;
  /** Null for a loose chair. */
  tableId: string | null;
  run: string;
  disabled: boolean;
  label: string | null;
  occupant: SeatOccupant | null;
}

type PlanParts = Pick<SeatingPlanDto, "groups" | "people" | "assignments">;

/** Every seat of the room in walk order, each with who sits there. */
export function seatViews(
  layout: SeatingLayout,
  walk: SeatingWalk,
  plan: PlanParts,
): SeatView[] {
  const points = seatPoints(layout);
  const people = new Map(plan.people.map((person) => [person.id, person]));
  const groups = new Map(plan.groups.map((group) => [group.id, group]));
  const occupantOf = new Map(
    plan.assignments.map((entry) => [entry.seatId, entry.personId]),
  );
  return walkOrder(walk).flatMap((seat) => {
    const point = points.get(seat.id);
    if (!point) return [];
    const person = people.get(occupantOf.get(seat.id) ?? "");
    const group = person ? (groups.get(person.groupId) ?? null) : null;
    return [
      {
        id: seat.id,
        x: point.x,
        y: point.y,
        facing: point.facing,
        tableId: seat.tableId,
        run: seat.run,
        disabled: seat.disabled,
        label: seat.label,
        occupant: person
          ? {
              person,
              group,
              colour: group ? seatingGroupColour(group) : "neutral",
            }
          : null,
      },
    ];
  });
}

// Geometry helpers ---------------------------------------------------------------

/** The unit vector of a facing (clockwise, 0 up the page). */
export function facingVector(facing: number): { x: number; y: number } {
  const angle = (normalizeRotation(facing) * Math.PI) / 180;
  return {
    x: Math.round(Math.sin(angle) * 1e6) / 1e6 || 0,
    y: Math.round(-Math.cos(angle) * 1e6) / 1e6 || 0,
  };
}

/**
 * The angle text along a table's edge is turned by, never upside down:
 * seats facing up or down the page read flat, the arms of a U read along
 * the arm.
 */
export function readableAngle(facing: number): number {
  const angle = normalizeRotation(facing);
  if (angle > 90 && angle <= 270) return angle - 180;
  if (angle > 270) return angle - 360;
  return angle;
}

/** How far into the table, from a seat's centre, its label is written. */
export const SEAT_LABEL_DEPTH = SEATING_SEAT_OFFSET + 13;
/** How far below a loose chair's centre its label is written. */
export const CHAIR_LABEL_DROP = SEATING_SEAT_DIAMETER / 2 + 13;

export interface PlanLabel {
  x: number;
  y: number;
  /** Degrees, for `rotate(angle x y)`. */
  angle: number;
}

/** Where the acronym of a seat (or a block) is written: on the table side. */
export function labelPlacement(
  point: { x: number; y: number; facing: number },
  onTable: boolean,
): PlanLabel {
  if (!onTable) return { x: point.x, y: point.y + CHAIR_LABEL_DROP, angle: 0 };
  const towards = facingVector(point.facing);
  return {
    x: point.x + towards.x * SEAT_LABEL_DEPTH,
    y: point.y + towards.y * SEAT_LABEL_DEPTH,
    angle: readableAngle(point.facing),
  };
}

// Blocks («Cuentas») ---------------------------------------------------------------

/**
 * One contiguous block of an account along one table's edge: a capsule
 * through `points` (a circle for a single seat). A delegation seated along
 * a run that turns a corner makes one block per table.
 */
export interface AccountBlock {
  /** Stable while the block keeps its first seat. */
  key: string;
  groupId: string;
  colour: SeatingColour;
  seatIds: string[];
  points: { x: number; y: number }[];
  /** Where the image goes: the block's middle. */
  centre: { x: number; y: number };
  label: PlanLabel;
  /** Pending registrations among its people: its border is dashed. */
  pending: boolean;
}

export function accountBlocks(
  walk: SeatingWalk,
  seats: readonly SeatView[],
): AccountBlock[] {
  const byGroup = new Map<string, SeatView[]>();
  for (const seat of seats) {
    const group = seat.occupant?.group;
    if (!group) continue;
    const list = byGroup.get(group.id) ?? [];
    list.push(seat);
    byGroup.set(group.id, list);
  }
  const seatById = new Map(seats.map((seat) => [seat.id, seat]));
  const blocks: AccountBlock[] = [];
  for (const [groupId, own] of byGroup) {
    for (const piece of seatPieces(
      walk,
      own.map((seat) => seat.id),
    )) {
      // A piece follows its run, which may turn a corner onto another
      // table: one capsule per table, straight along its edge.
      let current: SeatView[] = [];
      const flush = () => {
        if (current.length) blocks.push(makeBlock(groupId, current));
        current = [];
      };
      for (const id of piece) {
        const seat = seatById.get(id)!;
        const head = current[0];
        // Another table, or another edge of it (a round table's seats each
        // face their own way): a new capsule.
        if (
          head &&
          (head.tableId !== seat.tableId || head.facing !== seat.facing)
        ) {
          flush();
        }
        current.push(seat);
      }
      flush();
    }
  }
  return blocks;
}

function makeBlock(groupId: string, seats: SeatView[]): AccountBlock {
  // The middle seat, or the two middle ones of an even block.
  const reference = seats[Math.floor((seats.length - 1) / 2)]!;
  const other = seats[Math.floor(seats.length / 2)]!;
  const centre = {
    x: (reference.x + other.x) / 2,
    y: (reference.y + other.y) / 2,
  };
  return {
    key: `${groupId}:${seats[0]!.id}`,
    groupId,
    colour: seats[0]!.occupant!.colour,
    seatIds: seats.map((seat) => seat.id),
    points: seats.map((seat) => ({ x: seat.x, y: seat.y })),
    centre,
    label: labelPlacement(
      { ...centre, facing: reference.facing },
      reference.tableId !== null,
    ),
    pending: seats.some((seat) => seat.occupant?.person.status === "pending"),
  };
}

/**
 * The outline of a capsule of `radius` from the first point to the last
 * (a block's seats lie on one straight edge), or a circle for one point.
 */
export function stadiumPath(
  points: readonly { x: number; y: number }[],
  radius: number,
): string {
  const from = points[0];
  const to = points[points.length - 1];
  if (!from || !to) return "";
  const r = (value: number) => Math.round(value * 100) / 100 || 0;
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < 0.5) {
    return [
      `M ${r(from.x - radius)} ${r(from.y)}`,
      `a ${r(radius)} ${r(radius)} 0 1 0 ${r(2 * radius)} 0`,
      `a ${r(radius)} ${r(radius)} 0 1 0 ${r(-2 * radius)} 0`,
      "Z",
    ].join(" ");
  }
  const nx = (-(to.y - from.y) / length) * radius;
  const ny = ((to.x - from.x) / length) * radius;
  return [
    `M ${r(from.x + nx)} ${r(from.y + ny)}`,
    `L ${r(to.x + nx)} ${r(to.y + ny)}`,
    `A ${r(radius)} ${r(radius)} 0 0 0 ${r(to.x - nx)} ${r(to.y - ny)}`,
    `L ${r(from.x - nx)} ${r(from.y - ny)}`,
    `A ${r(radius)} ${r(radius)} 0 0 0 ${r(from.x + nx)} ${r(from.y + ny)}`,
    "Z",
  ].join(" ");
}

/**
 * A font size (room units) at which `text` fits `width`, between `min` and
 * `max`: an acronym inside a seat's circle or a capsule.
 */
export function fitFontSize(
  text: string,
  width: number,
  max: number,
  min = 7,
): number {
  const characters = Math.max(1, Array.from(text).length);
  const size = width / (0.62 * characters);
  return Math.round(Math.min(max, Math.max(min, size)) * 10) / 10;
}

// People -----------------------------------------------------------------------------

const firstLetter = (text: string | null | undefined) =>
  Array.from((text ?? "").trim())[0]?.toLocaleUpperCase("es") ?? "";

/**
 * A person's initials for a seat without a photo: the first name's and the
 * first surname's. Null for a seat kept without a name (a silhouette).
 */
export function personInitials(
  person: Pick<SeatingPersonDto, "firstName" | "surname">,
): string | null {
  const first = firstLetter(person.firstName);
  if (!first) return null;
  return first + firstLetter(person.surname?.trim().split(/\s+/)[0]);
}

/** A person's full name, or null for a seat kept without one. */
export function personName(
  person: Pick<SeatingPersonDto, "firstName" | "surname">,
): string | null {
  const name = [person.firstName, person.surname]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

// Search («¿Dónde está…?») -------------------------------------------------------------

/** Lower case, without accents or extra spaces, for matching. */
export function normalizeSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es")
    .replace(/\s+/g, " ")
    .trim();
}

function personHaystack(
  person: SeatingPersonDto,
  group: SeatingGroupDto | null,
): string {
  return normalizeSearch(
    [
      person.firstName,
      person.surname,
      person.label,
      group?.acronym,
      group?.name,
      group?.member?.acronym,
      group?.member?.name,
      group?.member?.university,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export interface SeatingSearchResult {
  /** The seats of the people who match, in walk order. */
  seatIds: string[];
  /** People who match and need a seat but have none. */
  unseated: number;
}

/**
 * The seats of everyone whose name, cargo or account matches every word of
 * the query, accents and case aside. An empty query matches nothing.
 */
export function searchSeating(
  query: string,
  seats: readonly SeatView[],
  plan: PlanParts,
): SeatingSearchResult {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  if (words.length === 0) return { seatIds: [], unseated: 0 };
  const groups = new Map(plan.groups.map((group) => [group.id, group]));
  const matches = (person: SeatingPersonDto) => {
    const haystack = personHaystack(person, groups.get(person.groupId) ?? null);
    return words.every((word) => haystack.includes(word));
  };
  const seatIds = seats
    .filter((seat) => seat.occupant && matches(seat.occupant.person))
    .map((seat) => seat.id);
  const seated = new Set(plan.assignments.map((entry) => entry.personId));
  const unseated = plan.people.filter((person) => {
    const group = groups.get(person.groupId);
    return (
      !seated.has(person.id) &&
      person.needsSeat &&
      !person.goneAt &&
      !group?.goneAt &&
      matches(person)
    );
  }).length;
  return { seatIds, unseated };
}

// Loose chairs -------------------------------------------------------------------------

/** Room kept free around a new loose chair: no seat nor table closer. */
const CHAIR_CLEARANCE = SEATING_SEAT_DIAMETER + 15;
const CHAIR_GRID = 10;

const snap = (value: number) =>
  Math.round(value / CHAIR_GRID) * CHAIR_GRID || 0;

function insideBox(
  box: Pick<SeatingTable, "x" | "y" | "w" | "h" | "rotation">,
  point: { x: number; y: number },
  margin: number,
): boolean {
  const angle = (-normalizeRotation(box.rotation) * Math.PI) / 180;
  const dx = point.x - box.x;
  const dy = point.y - box.y;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  return (
    Math.abs(localX) <= box.w / 2 + margin &&
    Math.abs(localY) <= box.h / 2 + margin
  );
}

/** Whether a loose chair fits at `point`, clear of every seat and table. */
export function isFreeSpot(
  layout: SeatingLayout,
  point: { x: number; y: number },
  ignoreChairId?: string,
): boolean {
  for (const [id, seat] of seatPoints(layout)) {
    if (id === ignoreChairId) continue;
    if (Math.hypot(seat.x - point.x, seat.y - point.y) < CHAIR_CLEARANCE) {
      return false;
    }
  }
  const margin = SEATING_SEAT_DIAMETER / 2 + 5;
  return ![...layout.tables, ...layout.fixtures].some((box) =>
    insideBox(box, point, margin),
  );
}

/**
 * Where «Añadir silla suelta» puts a chair: at `preferred` (the middle of
 * the view) when it is free, otherwise at the free spot nearest to it, on
 * the 10 cm grid.
 */
export function freeChairSpot(
  layout: SeatingLayout,
  preferred: { x: number; y: number },
): { x: number; y: number } {
  const start = { x: snap(preferred.x), y: snap(preferred.y) };
  if (isFreeSpot(layout, start)) return start;
  const step = CHAIR_CLEARANCE;
  for (let ring = 1; ring <= 40; ring += 1) {
    const count = ring * 8;
    for (let k = 0; k < count; k += 1) {
      const angle = (2 * Math.PI * k) / count;
      const candidate = {
        x: snap(start.x + ring * step * Math.cos(angle)),
        y: snap(start.y + ring * step * Math.sin(angle)),
      };
      if (isFreeSpot(layout, candidate)) return candidate;
    }
  }
  return { x: start.x, y: start.y };
}

// Editing the room -----------------------------------------------------------------------

/**
 * The room generated again from new numbers without losing seat ids to a
 * round trip. Turning a number down and up again on a draft (3 seats per
 * table, then 2, then 3) would otherwise mint new ids for seats that never
 * left the saved room, and the server would take their people for lost.
 * So `previous` is the draft with the saved room's tables and seats the
 * draft dropped put back underneath it (the draft wins where both have a
 * seat), and regenerateSeatingLayout keeps every id it finds there.
 */
export function regenerateKeepingIds(
  draft: SeatingLayout,
  saved: SeatingLayout | null,
  template: SeatingTemplate,
): SeatingLayout {
  if (!saved) return regenerateSeatingLayout(draft, template);
  const savedBySlot = new Map(
    saved.tables.flatMap((table) => (table.slot ? [[table.slot, table]] : [])),
  );
  const draftSlots = new Set(
    draft.tables.flatMap((table) => (table.slot ? [table.slot] : [])),
  );
  const draftSeatIds = new Set(
    draft.tables.flatMap((table) => table.seats.map((seat) => seat.id)),
  );
  const merged: SeatingTable[] = draft.tables.map((table) => {
    const old = table.slot ? savedBySlot.get(table.slot) : undefined;
    if (!old) return table;
    const has = new Set(
      table.seats.map((seat) => `${seat.side}:${seat.index}`),
    );
    const back: SeatingSeat[] = old.seats.filter(
      (seat) =>
        !has.has(`${seat.side}:${seat.index}`) && !draftSeatIds.has(seat.id),
    );
    return back.length ? { ...table, seats: [...table.seats, ...back] } : table;
  });
  for (const table of saved.tables) {
    if (table.slot && !draftSlots.has(table.slot)) merged.push(table);
  }
  return regenerateSeatingLayout({ ...draft, tables: merged }, template);
}

/** The Doble U's numbers, in the order the form shows them. */
export const DOUBLE_U_FIELDS = [
  "outerArmTables",
  "outerBaseTables",
  "innerArmTables",
  "innerBaseTables",
  "seatsPerTable",
  "mesaSeats",
  "gap",
] as const satisfies readonly (keyof DoubleUParams)[];

export interface DoubleUProblem {
  /** The number at fault, when it is one. */
  field: keyof DoubleUParams | null;
  /** i18n key under `seating.doubleU.problems`, and its values. */
  key: string;
  values: Record<string, number>;
}

/**
 * What is wrong with a Doble U's numbers, worded through i18n from
 * DOUBLE_U_LIMITS (doubleUParamsProblem's own text is for the API), or
 * null when they make a room.
 */
export function doubleUProblem(params: DoubleUParams): DoubleUProblem | null {
  for (const field of DOUBLE_U_FIELDS) {
    const value = params[field];
    const limit = DOUBLE_U_LIMITS[field];
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      return {
        field,
        key: "seating.doubleU.problems.range",
        values: { min: limit.min, max: limit.max },
      };
    }
  }
  if (params.gap % DOUBLE_U_LIMITS.gap.step !== 0) {
    return {
      field: "gap",
      key: "seating.doubleU.problems.gapStep",
      values: { step: DOUBLE_U_LIMITS.gap.step },
    };
  }
  const hasInner = params.innerArmTables > 0 || params.innerBaseTables > 0;
  if (hasInner && params.outerBaseTables < params.innerBaseTables + 2) {
    return {
      field: "outerBaseTables",
      key: "seating.doubleU.problems.base",
      values: { count: params.innerBaseTables + 2 },
    };
  }
  return doubleUParamsProblem(params)
    ? { field: null, key: "seating.doubleU.problems.other", values: {} }
    : null;
}

/** JSON with every object's keys sorted; arrays keep their order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Whether two layouts are the same room (the draft has no changes). The
 * order of keys does not count: the server stores the layout as jsonb,
 * which hands its keys back in its own order.
 */
export function sameLayout(
  a: SeatingLayout | null,
  b: SeatingLayout | null,
): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Whether two lock tokens name the same instant (null only matches null). */
export function sameToken(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right)
    ? left === right
    : a === b;
}

// Words -----------------------------------------------------------------------------------

/** The i18n key of a seat's name by its run, under `seating.seat.name`. */
export function seatNameKey(kind: SeatingRunKind): string {
  switch (kind) {
    case "presiding":
      return "seating.seat.name.presiding";
    case "outer_u":
      return "seating.seat.name.outerU";
    case "inner_u":
      return "seating.seat.name.innerU";
    case "loose":
      return "seating.seat.name.loose";
    default:
      return "seating.seat.name.other";
  }
}

/**
 * The `data` a refusal of the seating endpoints carries (createError's
 * `data` reaches the client at `error.data.data`), when its `reason` is the
 * one asked for: the room as it is now on a `seating_stale`, the occupied
 * seats on a `seating_seats_occupied`.
 */
export function seatingRefusal<T extends object>(
  error: unknown,
  reason: string,
): T | null {
  if (!error || typeof error !== "object") return null;
  const body = (error as { data?: unknown }).data;
  if (!body || typeof body !== "object") return null;
  const inner = (body as { data?: unknown }).data;
  if (!inner || typeof inner !== "object") return null;
  return (inner as { reason?: unknown }).reason === reason
    ? (inner as T)
    : null;
}

/** Minutes after which an editor's visit reads the Intranet again. */
export const SEATING_SYNC_STALE_MINUTES = 10;

/**
 * Whether opening the page should read the Intranet: never read, or read
 * more than ten minutes ago (the server throttles to one a minute anyway).
 */
export function syncDue(
  at: string | null,
  now: number,
  minutes = SEATING_SYNC_STALE_MINUTES,
): boolean {
  if (!at) return true;
  const time = Date.parse(at);
  return !Number.isFinite(time) || now - time > minutes * 60_000;
}

/** Live events that may change the room: its own, or a poll after a gap. */
export function affectsSeating(
  events: readonly { type: string; entityType: string }[],
): boolean {
  return events.some(
    (event) => event.type === "poll" || event.entityType === "seating",
  );
}
