/**
 * Sorting and filtering the control sheet's lists, and how both live in the
 * page's query next to `vista` and `documento`. Pure, so it is unit-tested
 * on its own (-filters.test.ts).
 *
 * The rows are never filtered in place: the panel and the notes of
 * «Enmiendas» (liveAmendmentNote) need every row, so the page derives the
 * rows it shows with shownGeneralRows and shownAmendmentRows. Rows the page
 * must keep in view whatever the filters and the order (the one in debate,
 * even when it is a heading, the one whose panel is open, the ones already
 * seen under the filters in use, so a row never vanishes under the reader's
 * hand) come in `keepIds`.
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */

import type { LocationQuery } from "vue-router";
import { PROPONENT_POSITIONS } from "~~/shared/constants/domain";
import type { ControlSheetResult } from "~~/shared/utils/controlSheet";
import {
  LIVE_AMENDMENT_STATES,
  type LiveAmendmentState,
} from "~/components/live-view/-model";
import {
  amendmentSheetKind,
  rowVoteEntries,
  type AmendmentSheetRow,
  type GeneralSheetRow,
} from "./-model";

// Sorting --------------------------------------------------------------------

export type SortDir = "asc" | "desc";

export interface SheetSort<K extends string> {
  key: K;
  dir: SortDir;
  /**
   * In a column of states (a result, an answer), the state that goes first
   * (user's decision of 2026-11-19), the rest after it in the column's own
   * order and direction. One of SHEET_SORT_LEADS for the key; absent or
   * null otherwise.
   */
  lead?: string | null;
}

/** The columns «General» sorts by. `number` is the agenda's own order. */
export const GENERAL_SORT_KEYS = [
  "number",
  "item",
  "proponent",
  "treated",
  "result",
  "votes",
  "speakers",
] as const;
export type GeneralSortKey = (typeof GENERAL_SORT_KEYS)[number];

/**
 * The orders «Enmiendas» sorts by. `treatment` is the order they are dealt
 * with, the console's (text order, by answer once public: the default, no
 * column of its own); `document`, where each acts in the text, whatever
 * the answers (user's decision of 2026-11-20: the treatment order puts the
 * accepted ones first), no column of its own either; `code`, the
 * «Enmienda» column, is the order they were presented in (user's decision
 * of 2026-11-19).
 */
export const AMENDMENT_SORT_KEYS = [
  "treatment",
  "document",
  "code",
  "authors",
  "kind",
  "position",
  "treated",
  "result",
  "vote",
  "speakers",
] as const;
export type AmendmentSortKey = (typeof AMENDMENT_SORT_KEYS)[number];

export const DEFAULT_GENERAL_SORT: SheetSort<GeneralSortKey> = {
  key: "number",
  dir: "asc",
};
export const DEFAULT_AMENDMENT_SORT: SheetSort<AmendmentSortKey> = {
  key: "treatment",
  dir: "asc",
};

/** The default order: the agenda's (with its headings) or the console's. */
export function isDefaultSort<K extends string>(
  sort: SheetSort<K>,
  fallback: SheetSort<K>,
): boolean {
  return sort.key === fallback.key && sort.dir === fallback.dir && !sort.lead;
}

/**
 * What choosing a column does: ascending first, then descending, then back
 * to the default order. The default column only switches direction.
 */
export function nextSort<K extends string>(
  current: SheetSort<K>,
  key: K,
  fallback: SheetSort<K>,
): SheetSort<K> {
  if (current.key !== key) return { key, dir: "asc" };
  // The state chosen to go first stays while the direction turns.
  const lead = current.lead ? { lead: current.lead } : {};
  if (key === fallback.key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc", ...lead };
  }
  return current.dir === "asc"
    ? { key, dir: "desc", ...lead }
    : { ...fallback };
}

/**
 * A row's place in one column: a value to compare, or null for an empty
 * one (no vote, no CEA position, no answer of the main presenter), which
 * goes last whichever the direction.
 */
type SortValue = number | string | null;

function compareValues(
  a: SortValue,
  b: SortValue,
  dir: SortDir,
  collator: Intl.Collator,
): number {
  if (a === null || b === null) {
    if (a === b) return 0;
    return a === null ? 1 : -1;
  }
  const order =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : collator.compare(String(a), String(b));
  return dir === "asc" ? order : -order;
}

function sortBy<T>(
  rows: readonly T[],
  value: (row: T) => SortValue,
  tieBreak: (row: T) => number,
  dir: SortDir,
  locale: string,
  /** The rows of the state chosen to go first (SheetSort.lead). */
  first?: (row: T) => boolean,
): T[] {
  const collator = new Intl.Collator(locale, {
    numeric: true,
    sensitivity: "base",
  });
  const lead = (row: T) => (first?.(row) ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      lead(a) - lead(b) ||
      compareValues(value(a), value(b), dir, collator) ||
      tieBreak(a) - tieBreak(b),
  );
}

// States that may go first ------------------------------------------------------

/**
 * The main presenter's answers as «Respuesta del proponente» reads them:
 * `none` is a row without one.
 */
export const POSITION_LEADS = [
  "accept",
  "transact",
  "reject",
  "pending",
  "none",
] as const;
export type PositionLead = (typeof POSITION_LEADS)[number];

/** «Resultado» in «General»: decided results first, «Pendiente» last. */
const RESULT_ORDER: readonly ControlSheetResult[] = [
  "approved",
  "approved_unanimous",
  "rejected",
  "mixed",
  "lapsed",
  "withdrawn",
  "postponed",
  "not_applicable",
];

/** When the row's latest vote was recorded; null without one. */
function latestVoteAt(row: GeneralSheetRow): string | null {
  let latest: string | null = null;
  for (const entry of rowVoteEntries(row)) {
    if (!latest || entry.vote.recordedAt > latest) {
      latest = entry.vote.recordedAt;
    }
  }
  return latest;
}

/** A row's state in a column of states; null for any other column. */
function generalLeadValue(
  row: GeneralSheetRow,
  key: GeneralSortKey,
): string | null {
  return key === "result" ? (row.outcome.result ?? "pending") : null;
}

function generalSortValue(
  row: GeneralSheetRow,
  key: GeneralSortKey,
): SortValue {
  switch (key) {
    case "number":
      return row.index;
    case "item":
      return row.title;
    case "proponent":
      return (
        row.documents.find((document) => document.proponent)?.proponent
          ?.acronym ?? null
      );
    case "treated":
      return row.outcome.treated ? 1 : 0;
    case "result":
      return row.outcome.result === null
        ? null
        : RESULT_ORDER.indexOf(row.outcome.result);
    case "votes":
      return latestVoteAt(row);
    case "speakers":
      return row.speakers.length;
  }
}

function mainAuthorAcronym(row: AmendmentSheetRow): string | null {
  const { authors, mainAuthorId } = row.amendment;
  const main = authors.find((author) => author.id === mainAuthorId);
  return (main ?? authors[0])?.acronym ?? null;
}

/** A row's state in a column of states; null for any other column. */
function amendmentLeadValue(
  row: AmendmentSheetRow,
  key: AmendmentSortKey,
): string | null {
  if (key === "result") return row.state;
  if (key === "position") return row.position?.position ?? "none";
  return null;
}

function amendmentSortValue(
  row: AmendmentSheetRow,
  key: AmendmentSortKey,
  position: number,
): SortValue {
  switch (key) {
    case "treatment":
      return position;
    case "document":
      // Where it acts in the text, then the order presented in: one key, so
      // amendments on the same block never fall back to the treatment order.
      return (
        row.amendment.positionKey * 1_000_000 +
        (row.amendment.number ?? 999_999)
      );
    case "code":
      // The order they were presented in; drafts never reach the sheet,
      // one presented before numbering existed goes last.
      return row.amendment.number;
    case "authors":
      return mainAuthorAcronym(row);
    case "kind":
      return amendmentSheetKind(row.amendment) === "formal" ? 1 : 0;
    case "position": {
      const answer = row.position;
      return answer === null
        ? null
        : PROPONENT_POSITIONS.indexOf(answer.position);
    }
    case "treated":
      return row.treated ? 1 : 0;
    case "result":
      return LIVE_AMENDMENT_STATES.indexOf(row.state);
    case "vote":
      return row.amendment.outcomeVote?.recordedAt ?? null;
    case "speakers":
      return row.speakers.length;
  }
}

// Filtering ------------------------------------------------------------------

/**
 * The chips of «General». «Pendientes» are the items not treated yet; the
 * observations are a filter (`observations`) since 2026-11-19.
 */
export const GENERAL_VIEWS = ["all", "pending", "treated"] as const;
export type GeneralView = (typeof GENERAL_VIEWS)[number];

/** The chips of «Enmiendas». «Pendientes» are the ones not treated yet. */
export const AMENDMENT_VIEWS = ["all", "pending", "treated"] as const;
export type AmendmentView = (typeof AMENDMENT_VIEWS)[number];

/** A result «General» filters by: one of the sheet's, or «Pendiente». */
export type ResultFilter = ControlSheetResult | "pending";
export const RESULT_FILTERS: readonly ResultFilter[] = [
  "pending",
  ...RESULT_ORDER,
];

/** Whether a row has a vote recorded (an item's, a document's, its own). */
export const VOTE_FILTERS = ["voted", "unvoted"] as const;
export type VoteFilter = (typeof VOTE_FILTERS)[number];

/** An amendment's type as the sheet reads it (amendmentSheetKind). */
export const KIND_FILTERS = ["content", "formal"] as const;
export type KindFilter = (typeof KIND_FILTERS)[number];

/**
 * The filters of «General». Every list is «any» when empty; members are
 * the main presenters of the item's documents, by id.
 */
export interface GeneralSheetFilters {
  query: string;
  view: GeneralView;
  results: ResultFilter[];
  members: string[];
  votes: VoteFilter[];
  /** Only the items the sheet has observations about (a sheet key's). */
  observations: boolean;
  /**
   * «Mis documentos»: only the items with a document the reader presents
   * (ControlSheetDocumentDto.presenting; user's decision of 2026-11-21).
   */
  mine: boolean;
}

/**
 * The filters of «Enmiendas». Every list is «any» when empty; members are
 * the amendment's authors, by id; positions the presenter's answer.
 */
export interface AmendmentSheetFilters {
  query: string;
  view: AmendmentView;
  states: LiveAmendmentState[];
  kinds: KindFilter[];
  members: string[];
  positions: PositionLead[];
  votes: VoteFilter[];
  /**
   * «Por responder»: only the amendments of a document the reader presents
   * that wait for its answer (AmendmentSheetRow.awaitsAnswer; user's
   * decision of 2026-11-21).
   */
  mine: boolean;
}

export const EMPTY_GENERAL_FILTERS: GeneralSheetFilters = {
  query: "",
  view: "all",
  results: [],
  members: [],
  votes: [],
  observations: false,
  mine: false,
};
export const EMPTY_AMENDMENT_FILTERS: AmendmentSheetFilters = {
  query: "",
  view: "all",
  states: [],
  kinds: [],
  members: [],
  positions: [],
  votes: [],
  mine: false,
};

/** The lists of «Filtros» a set of filters has, each «any» when empty. */
function filterLists(
  filters: GeneralSheetFilters | AmendmentSheetFilters,
): readonly (readonly string[])[] {
  return "results" in filters
    ? [
        filters.results,
        filters.members,
        filters.votes,
        filters.observations ? ["with"] : [],
        filters.mine ? ["mine"] : [],
      ]
    : [
        filters.states,
        filters.kinds,
        filters.members,
        filters.positions,
        filters.votes,
        filters.mine ? ["mine"] : [],
      ];
}

/** Filters in use, the search included; the chip «Todos» is none. */
export function activeFilterCount(
  filters: GeneralSheetFilters | AmendmentSheetFilters,
): number {
  return (
    (filters.query.trim() ? 1 : 0) +
    (filters.view === "all" ? 0 : 1) +
    filterLists(filters).filter((values) => values.length > 0).length
  );
}

/** What the filters are, as one string: it changes when they change. */
export function filtersKey(
  filters: GeneralSheetFilters | AmendmentSheetFilters,
): string {
  return [
    filters.query.trim(),
    filters.view,
    ...filterLists(filters).map((values) => values.join(",")),
  ].join("|");
}

/** Whether a vote filter lets a row through: none chosen lets every one. */
function passesVotes(votes: readonly VoteFilter[], voted: boolean): boolean {
  return votes.length === 0 || votes.includes(voted ? "voted" : "unvoted");
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function searchTokens(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** "14", "14.2" or "14.": a token that may be an agenda number. */
const NUMBER_TOKEN = /^\d+(?:\.\d+)*\.?$/;

/**
 * Whether a row of «General» passes the search: every word is in its
 * title, its documents' titles, their presenters or its speakers. A
 * word that looks like a number also passes when it is the row's number or
 * one above it ("14" finds 14, 14.1 and 14.2, never 4 or 114).
 */
function generalMatchesQuery(row: GeneralSheetRow, query: string): boolean {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return true;
  const text = fold(
    [
      row.title,
      ...row.documents.flatMap((document) => [
        document.title,
        ...[document.proponent, ...document.coProponents].flatMap((member) =>
          member ? [member.acronym, member.name] : [],
        ),
      ]),
      ...row.speakers.flatMap((speaker) => [speaker.label, ...speaker.names]),
    ].join(" "),
  );
  return tokens.every((token) => {
    if (text.includes(token)) return true;
    if (!NUMBER_TOKEN.test(token) || !row.number) return false;
    const wanted = token.replace(/\.$/, "");
    return row.number === wanted || row.number.startsWith(`${wanted}.`);
  });
}

/** Whether an item row passes the filters (heading rows never do). */
export function generalRowMatches(
  row: GeneralSheetRow,
  filters: GeneralSheetFilters,
): boolean {
  if (row.kind !== "item") return false;
  if (filters.view === "pending" && row.outcome.treated) return false;
  if (filters.view === "treated" && !row.outcome.treated) return false;
  if (filters.observations && !row.sheet?.observations.trim()) return false;
  if (filters.mine && !row.documents.some((document) => document.presenting)) {
    return false;
  }
  if (
    filters.results.length > 0 &&
    !filters.results.includes(row.outcome.result ?? "pending")
  ) {
    return false;
  }
  if (
    filters.members.length > 0 &&
    !row.documents.some(
      (document) =>
        document.proponent && filters.members.includes(document.proponent.id),
    )
  ) {
    return false;
  }
  if (!passesVotes(filters.votes, rowVoteEntries(row).length > 0)) {
    return false;
  }
  return generalMatchesQuery(row, filters.query);
}

/** Whether an amendment passes: its code and who presents it. */
export function amendmentRowMatches(
  row: AmendmentSheetRow,
  filters: AmendmentSheetFilters,
): boolean {
  if (filters.view === "pending" && row.treated) return false;
  if (filters.view === "treated" && !row.treated) return false;
  if (filters.mine && !row.awaitsAnswer) return false;
  if (filters.states.length > 0 && !filters.states.includes(row.state)) {
    return false;
  }
  if (
    filters.kinds.length > 0 &&
    !filters.kinds.includes(amendmentSheetKind(row.amendment))
  ) {
    return false;
  }
  if (
    filters.members.length > 0 &&
    !row.amendment.authors.some((author) => filters.members.includes(author.id))
  ) {
    return false;
  }
  if (
    filters.positions.length > 0 &&
    !filters.positions.includes(row.position?.position ?? "none")
  ) {
    return false;
  }
  if (!passesVotes(filters.votes, row.amendment.outcomeVote !== null)) {
    return false;
  }
  const tokens = searchTokens(filters.query);
  if (tokens.length === 0) return true;
  const text = fold(
    [
      row.amendment.code ?? "",
      ...row.amendment.authors.flatMap((author) => [
        author.acronym,
        author.name,
      ]),
    ].join(" "),
  );
  return tokens.every((token) => text.includes(token));
}

/** The ids of the rows that pass the filters now. */
export function matchingGeneralIds(
  rows: readonly GeneralSheetRow[],
  filters: GeneralSheetFilters,
): Set<string> {
  return new Set(
    rows.filter((row) => generalRowMatches(row, filters)).map((row) => row.id),
  );
}

export function matchingAmendmentIds(
  rows: readonly AmendmentSheetRow[],
  filters: AmendmentSheetFilters,
): Set<string> {
  return new Set(
    rows
      .filter((row) => amendmentRowMatches(row, filters))
      .map((row) => row.amendment.id),
  );
}

/**
 * The rows already seen under the filters in use: the ones that pass now,
 * plus the ones that passed before, unless the filters changed (`reset`).
 * Returns `previous` itself when nothing new passed, so a watcher writing it
 * back does not trigger again.
 */
export function keepSeen(
  previous: ReadonlySet<string>,
  matching: ReadonlySet<string>,
  reset: boolean,
): ReadonlySet<string> {
  if (reset) return new Set(matching);
  if ([...matching].every((id) => previous.has(id))) return previous;
  return new Set([...previous, ...matching]);
}

/**
 * The rows «General» shows. In the agenda's order every item row that
 * passes (or is kept) stays where it is, under the items above it as
 * headings; an item row that does not pass but has rows shown under it
 * stays as a heading. Any other order lists the item rows alone, sorted,
 * ties in the agenda's order (each row then names the item it hangs from).
 *
 * A kept row that is a heading stays too, whatever is shown under it: the
 * Mesa may put any item on screen, «14. Resoluciones» included, and its row
 * must be there to be found and marked. In the agenda's order it keeps its
 * place under the items above it; in any other order it is sorted among the
 * item rows, still a heading.
 */
export function shownGeneralRows(
  rows: readonly GeneralSheetRow[],
  sort: SheetSort<GeneralSortKey>,
  filters: GeneralSheetFilters,
  keepIds: ReadonlySet<string> = new Set(),
  locale = "es",
): GeneralSheetRow[] {
  // generalRowMatches never passes a heading: only keeping one shows it.
  const shown = rows.filter(
    (row) => keepIds.has(row.id) || generalRowMatches(row, filters),
  );
  if (isDefaultSort(sort, DEFAULT_GENERAL_SORT)) {
    const shownIds = new Set(shown.map((row) => row.id));
    const above = new Set(shown.flatMap((row) => row.ancestorIds));
    return rows.flatMap((row): GeneralSheetRow[] => {
      if (shownIds.has(row.id)) return [row];
      if (!above.has(row.id)) return [];
      return [row.kind === "heading" ? row : { ...row, kind: "heading" }];
    });
  }
  const lead = sort.lead ?? null;
  return sortBy(
    shown,
    (row) => generalSortValue(row, sort.key),
    (row) => row.index,
    sort.dir,
    locale,
    lead ? (row) => generalLeadValue(row, sort.key) === lead : undefined,
  );
}

/**
 * The rows «Enmiendas» shows: the ones that pass (or are kept), in the
 * console's order or sorted by a column, ties in the console's order.
 */
export function shownAmendmentRows(
  rows: readonly AmendmentSheetRow[],
  sort: SheetSort<AmendmentSortKey>,
  filters: AmendmentSheetFilters,
  keepIds: ReadonlySet<string> = new Set(),
  locale = "es",
): AmendmentSheetRow[] {
  const position = new Map(rows.map((row, index) => [row.amendment.id, index]));
  const shown = rows.filter(
    (row) => keepIds.has(row.amendment.id) || amendmentRowMatches(row, filters),
  );
  if (isDefaultSort(sort, DEFAULT_AMENDMENT_SORT)) return shown;
  const at = (row: AmendmentSheetRow) => position.get(row.amendment.id) ?? 0;
  const lead = sort.lead ?? null;
  return sortBy(
    shown,
    (row) => amendmentSortValue(row, sort.key, at(row)),
    at,
    sort.dir,
    locale,
    lead ? (row) => amendmentLeadValue(row, sort.key) === lead : undefined,
  );
}

// The query ------------------------------------------------------------------

/**
 * The query keys, in Spanish like `vista` and `documento`. Both tabs use
 * the same ones: changing tab clears them (SHEET_FILTER_QUERY_KEYS).
 */
export const SHEET_QUERY = {
  sort: "orden",
  dir: "sentido",
  /** The state that goes first in a column of states. */
  lead: "primero",
  search: "q",
  view: "ver",
  results: "resultado",
  states: "estado",
  kinds: "tipo",
  members: "quien",
  positions: "respuesta",
  votes: "votacion",
  observations: "observaciones",
  /** «Mis documentos» / «Por responder»: `si`. */
  mine: "mios",
} as const;

export const SHEET_FILTER_QUERY_KEYS: readonly string[] =
  Object.values(SHEET_QUERY);

const GENERAL_SORT_SLUGS: Record<GeneralSortKey, string> = {
  number: "numero",
  item: "punto",
  proponent: "proponente",
  treated: "tratado",
  result: "resultado",
  votes: "votaciones",
  speakers: "intervinientes",
};
const AMENDMENT_SORT_SLUGS: Record<AmendmentSortKey, string> = {
  treatment: "tratamiento",
  document: "documento",
  code: "presentacion",
  authors: "presenta",
  kind: "tipo",
  position: "respuesta",
  treated: "tratada",
  result: "resultado",
  vote: "votacion",
  speakers: "intervinientes",
};
const GENERAL_VIEW_SLUGS: Record<GeneralView, string> = {
  all: "todos",
  pending: "pendientes",
  treated: "tratados",
};
const VOTE_SLUGS: Record<VoteFilter, string> = {
  voted: "votadas",
  unvoted: "sin-votar",
};
const KIND_SLUGS: Record<KindFilter, string> = {
  content: "contenido",
  formal: "forma",
};
/** A member id as the query carries it (cuid2, or a fixed id). */
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const AMENDMENT_VIEW_SLUGS: Record<AmendmentView, string> = {
  all: "todas",
  pending: "pendientes",
  treated: "tratadas",
};
const RESULT_SLUGS: Record<ResultFilter, string> = {
  pending: "pendiente",
  approved: "aprobado",
  approved_unanimous: "unanimidad",
  rejected: "rechazado",
  mixed: "distintos",
  lapsed: "decaido",
  withdrawn: "retirado",
  postponed: "pospuesto",
  not_applicable: "no-aplica",
};
const STATE_SLUGS: Record<LiveAmendmentState, string> = {
  debating: "en-debate",
  pending: "pendiente",
  late: "fuera-de-plazo",
  approved: "aprobada",
  incorporated: "incorporada",
  rejected: "rechazada",
  transacted: "transaccionada",
  turned_down: "no-aceptada",
  withdrawn: "retirada",
  lapsed: "decaida",
  inadmissible: "inadmitida",
};

const POSITION_SLUGS: Record<PositionLead, string> = {
  accept: "acepta",
  transact: "transacciona",
  reject: "rechaza",
  pending: "pendiente",
  none: "sin-respuesta",
};

/**
 * The columns of states and the states each may put first, with their
 * slugs in the query (`primero`), in the column's own order.
 */
export const GENERAL_SORT_LEADS: Partial<
  Record<GeneralSortKey, readonly string[]>
> = { result: RESULT_FILTERS };
export const AMENDMENT_SORT_LEADS: Partial<
  Record<AmendmentSortKey, readonly string[]>
> = { result: LIVE_AMENDMENT_STATES, position: POSITION_LEADS };
const GENERAL_LEAD_SLUGS: Partial<
  Record<GeneralSortKey, Record<string, string>>
> = { result: RESULT_SLUGS };
const AMENDMENT_LEAD_SLUGS: Partial<
  Record<AmendmentSortKey, Record<string, string>>
> = { result: STATE_SLUGS, position: POSITION_SLUGS };

function firstValue(value: LocationQuery[string] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

/** The value whose slug this is, or null for anything else. */
function fromSlug<T extends string>(
  slugs: Record<T, string>,
  slug: string,
): T | null {
  const found = (Object.keys(slugs) as T[]).find((key) => slugs[key] === slug);
  return found ?? null;
}

/** A list of slugs ("aprobado,rechazado"), known ones only, in `order`. */
function listFromQuery<T extends string>(
  value: LocationQuery[string] | undefined,
  slugs: Record<T, string>,
  order: readonly T[],
): T[] {
  const raw = (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === "string")
    .flatMap((entry) => entry.split(","))
    .map((slug) => fromSlug(slugs, slug.trim()))
    .filter((entry): entry is T => entry !== null);
  const chosen = new Set(raw);
  return order.filter((entry) => chosen.has(entry));
}

/** Member ids from the query, well formed ones only, each once. */
function membersFromQuery(value: LocationQuery[string] | undefined): string[] {
  const raw = (Array.isArray(value) ? value : [value])
    .filter((entry): entry is string => typeof entry === "string")
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => MEMBER_ID.test(entry));
  return [...new Set(raw)];
}

function sortFromQuery<K extends string>(
  query: LocationQuery,
  slugs: Record<K, string>,
  fallback: SheetSort<K>,
  leadSlugs: Partial<Record<K, Record<string, string>>>,
): SheetSort<K> {
  const slug = firstValue(query[SHEET_QUERY.sort]);
  const key = slug ? fromSlug(slugs, slug) : fallback.key;
  // A column it does not know: the default order, whatever the direction.
  if (key === null) return { ...fallback };
  const dir = firstValue(query[SHEET_QUERY.dir]) === "desc" ? "desc" : "asc";
  // A state the column has, or none.
  const states = leadSlugs[key];
  const lead = states
    ? fromSlug(states, firstValue(query[SHEET_QUERY.lead]))
    : null;
  return lead ? { key, dir, lead } : { key, dir };
}

export interface GeneralSheetState {
  sort: SheetSort<GeneralSortKey>;
  filters: GeneralSheetFilters;
}

export interface AmendmentSheetState {
  sort: SheetSort<AmendmentSortKey>;
  filters: AmendmentSheetFilters;
}

/** What «General» shows, read from the query; anything unknown is left out. */
export function parseGeneralSheetQuery(
  query: LocationQuery,
): GeneralSheetState {
  return {
    sort: sortFromQuery(
      query,
      GENERAL_SORT_SLUGS,
      DEFAULT_GENERAL_SORT,
      GENERAL_LEAD_SLUGS,
    ),
    filters: {
      query: firstValue(query[SHEET_QUERY.search]).trim(),
      view:
        fromSlug(GENERAL_VIEW_SLUGS, firstValue(query[SHEET_QUERY.view])) ??
        "all",
      results: listFromQuery(
        query[SHEET_QUERY.results],
        RESULT_SLUGS,
        RESULT_FILTERS,
      ),
      members: membersFromQuery(query[SHEET_QUERY.members]),
      votes: listFromQuery(query[SHEET_QUERY.votes], VOTE_SLUGS, VOTE_FILTERS),
      observations: firstValue(query[SHEET_QUERY.observations]) === "con",
      mine: firstValue(query[SHEET_QUERY.mine]) === "si",
    },
  };
}

export function parseAmendmentSheetQuery(
  query: LocationQuery,
): AmendmentSheetState {
  return {
    sort: sortFromQuery(
      query,
      AMENDMENT_SORT_SLUGS,
      DEFAULT_AMENDMENT_SORT,
      AMENDMENT_LEAD_SLUGS,
    ),
    filters: {
      query: firstValue(query[SHEET_QUERY.search]).trim(),
      view:
        fromSlug(AMENDMENT_VIEW_SLUGS, firstValue(query[SHEET_QUERY.view])) ??
        "all",
      states: listFromQuery(
        query[SHEET_QUERY.states],
        STATE_SLUGS,
        LIVE_AMENDMENT_STATES,
      ),
      kinds: listFromQuery(query[SHEET_QUERY.kinds], KIND_SLUGS, KIND_FILTERS),
      members: membersFromQuery(query[SHEET_QUERY.members]),
      positions: listFromQuery(
        query[SHEET_QUERY.positions],
        POSITION_SLUGS,
        POSITION_LEADS,
      ),
      votes: listFromQuery(query[SHEET_QUERY.votes], VOTE_SLUGS, VOTE_FILTERS),
      mine: firstValue(query[SHEET_QUERY.mine]) === "si",
    },
  };
}

/** The query keys of a sort and filters; undefined drops a default. */
export type SheetQueryPatch = Record<string, string | undefined>;

function sortToQuery<K extends string>(
  sort: SheetSort<K>,
  slugs: Record<K, string>,
  fallback: SheetSort<K>,
  leadSlugs: Partial<Record<K, Record<string, string>>>,
): SheetQueryPatch {
  if (isDefaultSort(sort, fallback)) {
    return {
      [SHEET_QUERY.sort]: undefined,
      [SHEET_QUERY.dir]: undefined,
      [SHEET_QUERY.lead]: undefined,
    };
  }
  return {
    [SHEET_QUERY.sort]: sort.key === fallback.key ? undefined : slugs[sort.key],
    [SHEET_QUERY.dir]: sort.dir === "desc" ? "desc" : undefined,
    [SHEET_QUERY.lead]: sort.lead
      ? (leadSlugs[sort.key]?.[sort.lead] ?? undefined)
      : undefined,
  };
}

/** A list as slugs, in `order`, so one choice always reads the same. */
function listToQuery<T extends string>(
  values: readonly T[],
  slugs: Record<T, string>,
  order: readonly T[],
): string | undefined {
  const chosen = order.filter((value) => values.includes(value));
  return chosen.length > 0
    ? chosen.map((value) => slugs[value]).join(",")
    : undefined;
}

export function generalSheetQuery(state: GeneralSheetState): SheetQueryPatch {
  const { filters } = state;
  return {
    ...sortToQuery(
      state.sort,
      GENERAL_SORT_SLUGS,
      DEFAULT_GENERAL_SORT,
      GENERAL_LEAD_SLUGS,
    ),
    [SHEET_QUERY.search]: filters.query.trim() || undefined,
    [SHEET_QUERY.view]:
      filters.view === "all" ? undefined : GENERAL_VIEW_SLUGS[filters.view],
    [SHEET_QUERY.results]: listToQuery(
      filters.results,
      RESULT_SLUGS,
      RESULT_FILTERS,
    ),
    [SHEET_QUERY.states]: undefined,
    [SHEET_QUERY.kinds]: undefined,
    [SHEET_QUERY.members]:
      filters.members.length > 0 ? filters.members.join(",") : undefined,
    [SHEET_QUERY.positions]: undefined,
    [SHEET_QUERY.votes]: listToQuery(filters.votes, VOTE_SLUGS, VOTE_FILTERS),
    [SHEET_QUERY.observations]: filters.observations ? "con" : undefined,
    [SHEET_QUERY.mine]: filters.mine ? "si" : undefined,
  };
}

export function amendmentSheetQuery(
  state: AmendmentSheetState,
): SheetQueryPatch {
  const { filters } = state;
  return {
    ...sortToQuery(
      state.sort,
      AMENDMENT_SORT_SLUGS,
      DEFAULT_AMENDMENT_SORT,
      AMENDMENT_LEAD_SLUGS,
    ),
    [SHEET_QUERY.search]: filters.query.trim() || undefined,
    [SHEET_QUERY.view]:
      filters.view === "all" ? undefined : AMENDMENT_VIEW_SLUGS[filters.view],
    [SHEET_QUERY.results]: undefined,
    [SHEET_QUERY.states]: listToQuery(
      filters.states,
      STATE_SLUGS,
      LIVE_AMENDMENT_STATES,
    ),
    [SHEET_QUERY.kinds]: listToQuery(filters.kinds, KIND_SLUGS, KIND_FILTERS),
    [SHEET_QUERY.members]:
      filters.members.length > 0 ? filters.members.join(",") : undefined,
    [SHEET_QUERY.positions]: listToQuery(
      filters.positions,
      POSITION_SLUGS,
      POSITION_LEADS,
    ),
    [SHEET_QUERY.votes]: listToQuery(filters.votes, VOTE_SLUGS, VOTE_FILTERS),
    [SHEET_QUERY.observations]: undefined,
    [SHEET_QUERY.mine]: filters.mine ? "si" : undefined,
  };
}

/** The keys that clear every sort and filter (changing tab). */
export function clearedSheetQuery(): SheetQueryPatch {
  return Object.fromEntries(
    SHEET_FILTER_QUERY_KEYS.map((key) => [key, undefined]),
  );
}
