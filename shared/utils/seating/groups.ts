import type { AssemblyType } from "../../constants/assemblyTypes";
import type {
  MemberKind,
  SeatingGroupCategory,
  SeatingGroupKind,
  SeatingPersonStatus,
} from "../../constants/domain";
import { compareRollCall } from "../headcount";

/**
 * Groups and people of the seating view (docs/seating-plan.md, sections 3
 * and 7): how an Intranet account becomes a group, the colour of its place
 * cards, the order Proponer reparto seats groups in, and the counts of the
 * header, the tray and the legend. Pure.
 */

/** What these helpers read of a group (SeatingGroupDto has it all). */
export interface SeatingGroupInput {
  id: string;
  kind: SeatingGroupKind;
  /** `users.type` as the Intranet sent it; null for the Mesa and manual groups. */
  intranetType: string | null;
  acronym: string;
  name: string;
  /** The Intranet's place of a CEA office (CeaSortingService); null otherwise. */
  order: number | null;
  goneAt?: string | null;
  /**
   * The platform member it stands for, when linked: the roll call reads its
   * denomination and university, as the Mesa calls it.
   */
  member?: { name: string; university: string | null } | null;
}

/** What these helpers read of a person (SeatingPersonDto has it all). */
export interface SeatingPersonInput {
  id: string;
  groupId: string;
  /** False for «No necesita asiento»: out of every count. */
  needsSeat: boolean;
  /** The Intranet stopped listing them («Ya no inscrito»). */
  goneAt: string | null;
  /** Order inside the group. */
  position: number;
  status?: SeatingPersonStatus;
}

/** Who sits on a seat. */
export interface SeatAssignment {
  seatId: string;
  personId: string;
}

// From the Intranet -----------------------------------------------------------

/**
 * Where the Coordinación del CAS sits (a CEA account in the Intranet, the
 * member `CAS` here): with the sectoriales, right after them, never in the
 * `cea` zone (user, 2026-11-15; docs/seating-plan.md). Set it to "cea" to
 * seat it with the CEA again, last among the offices. Its kind stays `cea`
 * (the Intranet's type) and its colour green either way (seatingLegendKind
 * reads its Intranet type).
 */
export const CAS_SITS_WITH: "sectorial" | "cea" = "sectorial";

const intranetTypeKey = (type: string | null | undefined) =>
  (type ?? "").trim().toLowerCase();

/** The Coordinación del CAS: kind `cea`, Intranet type `CAS`. */
export function isCasGroup(
  group: Pick<SeatingGroupInput, "kind" | "intranetType">,
): boolean {
  return group.kind === "cea" && intranetTypeKey(group.intranetType) === "cas";
}

/**
 * Where Proponer reparto seats a group, by its kind, the CAS apart
 * (CAS_SITS_WITH): the `cea` zone for the CEA, the delegates' seats for
 * everyone else but the Mesa.
 */
export function seatingPlacementKind(
  group: Pick<SeatingGroupInput, "kind" | "intranetType">,
): SeatingGroupKind {
  return isCasGroup(group) ? CAS_SITS_WITH : group.kind;
}

/**
 * The kind of a group made from an Intranet account, by its `users.type`:
 * Asociado, Sectorial, CEA and the CAS (a CEA account) as the Intranet
 * has them, anything else (CAI, CdG, Invitado, Otros, Desasociado, the
 * host) `other`. Never `mesa`: that one is the platform's own group.
 */
export function seatingKindForIntranetType(
  type: string | null | undefined,
): SeatingGroupKind {
  switch (intranetTypeKey(type)) {
    case "asociado":
      return "asociado";
    case "sectorial":
      return "sectorial";
    case "cea":
    case "cas":
      return "cea";
    default:
      return "other";
  }
}

/** The Intranet's account category (`Individual`, `Multiusuario`). */
export function seatingCategoryForIntranet(
  category: string | null | undefined,
): SeatingGroupCategory | null {
  switch (intranetTypeKey(category)) {
    case "individual":
      return "individual";
    case "multiusuario":
      return "multiuser";
    default:
      return null;
  }
}

/** An Intranet registration's status (`Pendiente`, `Confirmada`). */
export function seatingStatusForIntranet(
  status: "Pendiente" | "Confirmada",
): Extract<SeatingPersonStatus, "confirmed" | "pending"> {
  return status === "Confirmada" ? "confirmed" : "pending";
}

// The room -------------------------------------------------------------------

/**
 * Whether an assembly of this type meets in a room, and so has a Sala: every
 * type but the AGET, held online. The section is hidden for it and the
 * server answers 404 (`seating_not_found`).
 */
export function hasSeatingRoom(type: AssemblyType): boolean {
  return type !== "AGET";
}

// The Mesa -------------------------------------------------------------------

/**
 * The Mesa's own group, made with the plan (never by a sync): content in
 * Spanish, like MESA_DEFAULT_LABELS.
 */
export const MESA_GROUP = {
  acronym: "Mesa",
  name: "Mesa de Moderación",
} as const;

/**
 * The CEA offices that sit at the Mesa's table, by their Intranet initials:
 * the Secretaría Ejecutiva at an AGO; CREUP's Presidencia and Secretaría at
 * an AGE and an AGET. A person is seated once: there they are not with the
 * CEA.
 */
export const MESA_OFFICE_ACRONYMS: Record<AssemblyType, readonly string[]> = {
  AGO: ["SE"],
  AGE: ["PRES", "SE"],
  AGET: ["PRES", "SE"],
};

/**
 * The people the Mesa's group starts with, to be named by hand: they do not
 * register in the Intranet. Content in Spanish, like a member's name: never
 * translated.
 */
export const MESA_DEFAULT_LABELS: Record<AssemblyType, readonly string[]> = {
  AGO: ["Presidencia de la Mesa", "Vocalía de la Mesa"],
  AGE: [],
  AGET: [],
};

/** Whether a group is a CEA office that sits at the Mesa at this assembly. */
export function isMesaOffice(
  group: Pick<SeatingGroupInput, "kind" | "intranetType" | "acronym">,
  assemblyType: AssemblyType,
): boolean {
  if (group.kind !== "cea" || isCasGroup(group)) return false;
  const acronym = group.acronym.trim().toUpperCase();
  return MESA_OFFICE_ACRONYMS[assemblyType].includes(acronym);
}

// Colours --------------------------------------------------------------------

/**
 * What the legend counts and the colour follows: the group's kind refined by
 * its Intranet type, so the CAS (kind `cea`) and the CAI and the CdG
 * (`other`) each have their own entry.
 */
export const SEATING_LEGEND_KINDS = [
  "mesa",
  "cea",
  "cdg",
  "asociado",
  "cai",
  "sectorial",
  "cas",
  "other",
] as const;
export type SeatingLegendKind = (typeof SEATING_LEGEND_KINDS)[number];

/**
 * The colours of the room's place cards, rings and tints only: Nuxt UI's
 * colours, and CREUP's beige (`--seating-beige` in main.css).
 */
export const SEATING_COLOURS = [
  "primary",
  "info",
  "sectorial",
  "beige",
  "neutral",
] as const;
export type SeatingColour = (typeof SEATING_COLOURS)[number];

/**
 * Burgundy for the CEA and the Mesa; green for the sectoriales and the CAS;
 * blue for the asociados and the CAI; beige for the CdG, the guests and every
 * other account (user, 2026-11-15). Grey (`neutral`) is left for a seat whose
 * group the plan lost. Only in this view: MemberBadge keeps its own colours
 * elsewhere.
 */
export const SEATING_LEGEND_COLOURS: Record<SeatingLegendKind, SeatingColour> =
  {
    mesa: "primary",
    cea: "primary",
    cdg: "beige",
    asociado: "info",
    cai: "info",
    sectorial: "sectorial",
    cas: "sectorial",
    other: "beige",
  };

export function seatingLegendKind(
  group: Pick<SeatingGroupInput, "kind" | "intranetType">,
): SeatingLegendKind {
  if (group.kind === "mesa") return "mesa";
  switch (intranetTypeKey(group.intranetType)) {
    case "cas":
      return "cas";
    case "cdg":
      return "cdg";
    case "cai":
      return "cai";
  }
  switch (group.kind) {
    case "cea":
      return "cea";
    case "asociado":
      return "asociado";
    case "sectorial":
      return "sectorial";
    default:
      return "other";
  }
}

/** A group's colour, from its kind and its Intranet type, never the kind alone. */
export function seatingGroupColour(
  group: Pick<SeatingGroupInput, "kind" | "intranetType">,
): SeatingColour {
  return SEATING_LEGEND_COLOURS[seatingLegendKind(group)];
}

// Order ----------------------------------------------------------------------

const KIND_RANK: Record<SeatingGroupKind, number> = {
  mesa: 0,
  cea: 1,
  asociado: 2,
  sectorial: 3,
  other: 5,
};

/**
 * A group's place in the order: its kind's, and the CAS's right after the
 * sectoriales when it sits with them (CAS_SITS_WITH), else with the CEA.
 */
const seatingRank = (group: SeatingGroupInput) =>
  isCasGroup(group) && CAS_SITS_WITH === "sectorial"
    ? KIND_RANK.sectorial + 1
    : KIND_RANK[group.kind];

const ROLL_CALL_KIND: Record<SeatingGroupKind, MemberKind> = {
  mesa: "other",
  cea: "executive",
  asociado: "asociado",
  sectorial: "sectorial",
  other: "other",
};

const compareText = (a: string, b: string) =>
  a.localeCompare(b, "es", { sensitivity: "base" });

/**
 * The order groups are seated in: the Mesa, the CEA in the Intranet's order
 * (offices without one after it, by acronym), then the asociados and the
 * sectoriales in the order of the roll call (compareRollCall: reverse
 * alphabetical by denomination and university), the CAS right after them
 * (CAS_SITS_WITH; with the CEA it comes among the offices), and the rest in
 * the order of the roll call. Groups the Intranet no longer lists go last.
 */
export function compareSeatingGroups(
  a: SeatingGroupInput,
  b: SeatingGroupInput,
): number {
  const gone = Number(Boolean(a.goneAt)) - Number(Boolean(b.goneAt));
  if (gone) return gone;
  const rank = seatingRank(a) - seatingRank(b);
  if (rank) return rank;
  if (a.kind === "cea") {
    const order =
      (a.order ?? Number.MAX_SAFE_INTEGER) -
      (b.order ?? Number.MAX_SAFE_INTEGER);
    return (
      order || compareText(a.acronym, b.acronym) || a.id.localeCompare(b.id)
    );
  }
  if (a.kind === "mesa") return a.id.localeCompare(b.id);
  const rollCall = (group: SeatingGroupInput) => ({
    kind: ROLL_CALL_KIND[group.kind],
    acronym: group.acronym,
    name: group.member?.name ?? group.name,
    university: group.member ? group.member.university : null,
  });
  return compareRollCall(rollCall(a), rollCall(b)) || a.id.localeCompare(b.id);
}

export function orderSeatingGroups<T extends SeatingGroupInput>(
  groups: readonly T[],
): T[] {
  return [...groups].sort(compareSeatingGroups);
}

/** A group's people in their order (position, then id). */
export function comparePeople(
  a: SeatingPersonInput,
  b: SeatingPersonInput,
): number {
  return a.position - b.position || a.id.localeCompare(b.id);
}

// Counts ---------------------------------------------------------------------

/**
 * Whether a person counts: needs a seat and is still registered (nor is the
 * group gone). Only they are placed by Proponer reparto and counted.
 */
export function needsSeat(
  person: Pick<SeatingPersonInput, "needsSeat" | "goneAt">,
  group?: Pick<SeatingGroupInput, "goneAt"> | null,
): boolean {
  return person.needsSeat && !person.goneAt && !group?.goneAt;
}

export interface SeatingCounts {
  /** People who need a seat. */
  people: number;
  /** Of them, seated. */
  seated: number;
  /** Of them, not seated. */
  unseated: number;
  /** Of them, with a pending registration. */
  pending: number;
  /** Marked «No necesita asiento» (and still registered). */
  notNeeded: number;
  /** No longer registered. */
  gone: number;
}

/** The header's counts: «93 personas · 88 sentadas · 5 sin asiento». */
export function seatingCounts(
  groups: readonly SeatingGroupInput[],
  people: readonly SeatingPersonInput[],
  assignments: readonly SeatAssignment[],
): SeatingCounts {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const seated = new Set(assignments.map((entry) => entry.personId));
  const counts: SeatingCounts = {
    people: 0,
    seated: 0,
    unseated: 0,
    pending: 0,
    notNeeded: 0,
    gone: 0,
  };
  for (const person of people) {
    const group = groupById.get(person.groupId);
    if (person.goneAt || group?.goneAt) {
      counts.gone += 1;
      continue;
    }
    if (!person.needsSeat) {
      counts.notNeeded += 1;
      continue;
    }
    counts.people += 1;
    if (seated.has(person.id)) counts.seated += 1;
    else counts.unseated += 1;
    if (person.status === "pending") counts.pending += 1;
  }
  return counts;
}

export interface GroupSeatCounts {
  /** People who need a seat («3 inscritos»). */
  total: number;
  /** Of them, seated (the badge «2/3»). */
  seated: number;
  /** Of them, pending («(1 pendiente)»). */
  pending: number;
}

/** Each group's counts, by group id (every group listed, even with none). */
export function groupSeatCounts(
  groups: readonly SeatingGroupInput[],
  people: readonly SeatingPersonInput[],
  assignments: readonly SeatAssignment[],
): Map<string, GroupSeatCounts> {
  const counts = new Map<string, GroupSeatCounts>(
    groups.map((group) => [group.id, { total: 0, seated: 0, pending: 0 }]),
  );
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const seated = new Set(assignments.map((entry) => entry.personId));
  for (const person of people) {
    const entry = counts.get(person.groupId);
    if (!entry || !needsSeat(person, groupById.get(person.groupId))) continue;
    entry.total += 1;
    if (seated.has(person.id)) entry.seated += 1;
    if (person.status === "pending") entry.pending += 1;
  }
  return counts;
}

export interface SeatingLegendEntry {
  kind: SeatingLegendKind;
  /** Kinds that share a colour share its swatch, never a count. */
  colour: SeatingColour;
  seated: number;
  total: number;
}

/**
 * The legend: one entry per kind with people who need a seat, in
 * SEATING_LEGEND_KINDS order, each with its own count («Asociados 48/52»,
 * «CAI 1/1»).
 */
export function seatingLegend(
  groups: readonly SeatingGroupInput[],
  people: readonly SeatingPersonInput[],
  assignments: readonly SeatAssignment[],
): SeatingLegendEntry[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const seated = new Set(assignments.map((entry) => entry.personId));
  const totals = new Map<
    SeatingLegendKind,
    { seated: number; total: number }
  >();
  for (const person of people) {
    const group = groupById.get(person.groupId);
    if (!group || !needsSeat(person, group)) continue;
    const kind = seatingLegendKind(group);
    const entry = totals.get(kind) ?? { seated: 0, total: 0 };
    entry.total += 1;
    if (seated.has(person.id)) entry.seated += 1;
    totals.set(kind, entry);
  }
  return SEATING_LEGEND_KINDS.flatMap((kind) => {
    const entry = totals.get(kind);
    return entry
      ? [{ kind, colour: SEATING_LEGEND_COLOURS[kind], ...entry }]
      : [];
  });
}
