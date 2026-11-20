/**
 * Coming back to the control sheet where the reader left it (user's
 * decision of 2026-11-19): leaving the page writes into its own history
 * entry (`history.state`, merged, as Vue Router keeps it) the scroll, the
 * first row in view, «Seguir el debate», what the Mesa had on screen, each
 * tab's order and filters and the search typed. Back, Forward or a reload
 * of that entry reads it again; the tab, the document and the current
 * filters come back with the URL itself. Pure, so it is unit-tested on its
 * own (-return.test.ts).
 *
 * The leading dash keeps Nuxt from registering this file as a component
 * (`ignorePrefix`); import it explicitly.
 */

/** The key in `history.state`. */
export const SHEET_RETURN_KEY = "controlSheet";

/** The tabs of the sheet. */
export const SHEET_TABS = [
  "general",
  "amendments",
  "turns",
  "history",
] as const;
export type SheetReturnTab = (typeof SHEET_TABS)[number];

/** What the Mesa had on screen. */
export interface SheetReturnLive {
  agendaItemId: string | null;
  documentId: string | null;
  amendmentId: string | null;
}

export interface SheetReturnState {
  assemblyId: string;
  /** The scroll area's position, used when the row is not found. */
  scrollTop: number;
  /** The first row in view and how far below the sticky tabs it was. */
  anchor: { rowId: string; offset: number } | null;
  follow: boolean;
  live: SheetReturnLive;
  /** Each other tab's order, filters and search, as `tabQueries` keeps them. */
  tabQueries: Partial<Record<SheetReturnTab, Record<string, string>>>;
  /** What the search box held, typed or not yet in the query. */
  search: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 64
    ? value
    : null;

/**
 * The saved state in `state` (window.history.state) for this assembly, or
 * null: none, another assembly's, or not in the right shape. Only the
 * query keys in `queryKeys` survive in each tab's query.
 */
export function readSheetReturn(
  state: unknown,
  assemblyId: string,
  queryKeys: readonly string[],
): SheetReturnState | null {
  if (!isRecord(state)) return null;
  const saved = state[SHEET_RETURN_KEY];
  if (!isRecord(saved) || saved.assemblyId !== assemblyId) return null;
  const scrollTop =
    typeof saved.scrollTop === "number" && Number.isFinite(saved.scrollTop)
      ? Math.max(0, saved.scrollTop)
      : 0;
  let anchor: SheetReturnState["anchor"] = null;
  if (
    isRecord(saved.anchor) &&
    idOrNull(saved.anchor.rowId) &&
    typeof saved.anchor.offset === "number" &&
    Number.isFinite(saved.anchor.offset)
  ) {
    anchor = {
      rowId: saved.anchor.rowId as string,
      offset: saved.anchor.offset,
    };
  }
  const live = isRecord(saved.live) ? saved.live : {};
  const tabQueries: SheetReturnState["tabQueries"] = {};
  if (isRecord(saved.tabQueries)) {
    for (const tab of SHEET_TABS) {
      const query = saved.tabQueries[tab];
      if (!isRecord(query)) continue;
      const kept: Record<string, string> = {};
      for (const key of queryKeys) {
        const value = query[key];
        if (typeof value === "string" && value.length <= 500) kept[key] = value;
      }
      tabQueries[tab] = kept;
    }
  }
  return {
    assemblyId,
    scrollTop,
    anchor,
    follow: saved.follow === true,
    live: {
      agendaItemId: idOrNull(live.agendaItemId),
      documentId: idOrNull(live.documentId),
      amendmentId: idOrNull(live.amendmentId),
    },
    tabQueries,
    search: typeof saved.search === "string" ? saved.search.slice(0, 500) : "",
  };
}

/** `state` with the sheet's saved state put in (or taken out with null). */
export function withSheetReturn(
  state: unknown,
  value: SheetReturnState | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = Object.fromEntries(
    Object.entries(isRecord(state) ? state : {}).filter(
      ([key]) => key !== SHEET_RETURN_KEY,
    ),
  );
  if (value) next[SHEET_RETURN_KEY] = value;
  return next;
}

/**
 * Whether the Mesa moved what is on screen while the reader was away: then
 * «Seguir el debate» takes the reader there, as following means; otherwise
 * the sheet stays where it was left.
 */
export function debateMoved(
  saved: SheetReturnLive,
  now: SheetReturnLive | null,
): boolean {
  const current = now ?? {
    agendaItemId: null,
    documentId: null,
    amendmentId: null,
  };
  return (
    saved.agendaItemId !== current.agendaItemId ||
    saved.documentId !== current.documentId ||
    saved.amendmentId !== current.amendmentId
  );
}

/**
 * The scroll position that puts a row `offset` pixels below the bottom of
 * the sticky tabs again, from where it is now (`rowTop`, `barBottom`: both
 * from getBoundingClientRect).
 */
export function scrollTopForAnchor(
  scrollTop: number,
  rowTop: number,
  barBottom: number,
  offset: number,
): number {
  return Math.max(0, scrollTop + rowTop - barBottom - offset);
}

/**
 * The first row in view below the sticky tabs, as the anchor to come back
 * to: `rows` are each row's id and its box (top and bottom), in page order.
 */
export function firstRowInView(
  rows: readonly { id: string; top: number; bottom: number }[],
  barBottom: number,
): { rowId: string; offset: number } | null {
  const row = rows.find((entry) => entry.bottom > barBottom);
  return row ? { rowId: row.id, offset: row.top - barBottom } : null;
}
