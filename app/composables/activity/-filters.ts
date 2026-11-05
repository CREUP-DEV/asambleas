import { parseDate, toZoned } from "@internationalized/date";
import {
  ACTIVITY_CATEGORIES,
  AUDIT_SOURCES,
  ME_ACTIVITY_TABS,
  type ActivityCategory,
  type AuditSource,
  type MeActivityTab,
} from "~~/shared/constants/activity";
import { ASSEMBLY_TIME_ZONE } from "~~/shared/utils/calendar";
import { USER_ID_PATTERN } from "~~/shared/utils/schemas/activity";

/**
 * Filters of "Mi actividad" (/actividad) and of the Admin's activity log
 * (/admin/actividad): read from and written to the URL query, so a view
 * survives a reload and can be shared, and turned into the query of
 * GET /api/me/activity, GET /api/admin/activity and
 * GET /api/admin/impersonations.
 *
 * Dates travel in the URL as days ("2026-11-05") and reach the API as the
 * instants that bound those days in the assemblies' time zone: `from` the
 * start of its day (inclusive), `to` the start of the day after (exclusive).
 */

/** A vue-router query: each value a string, null, or an array of them. */
export type ActivityRouteQuery = Record<string, unknown>;

/** Scalar query values, as useApi().get takes them (lists comma-joined). */
export type ActivityApiQuery = Record<string, string | undefined>;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** cuid2 ids of domain rows (members, impersonations). */
const ENTITY_ID_PATTERN = /^[a-z0-9]{20,32}$/;
/** An assembly slug ("80-ago") or id. */
const ASSEMBLY_REF_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The first string of a query value ("?a=1&a=2" gives "1"). */
function first(value: unknown): string | undefined {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" && one !== "" ? one : undefined;
}

/** Every value of a list filter, repeated or comma-separated, without duplicates. */
function list(value: unknown): string[] {
  const parts = (Array.isArray(value) ? value : [value])
    .filter((part): part is string => typeof part === "string")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return [...new Set(parts)];
}

function matching(value: string | undefined, pattern: RegExp): string | null {
  return value !== undefined && pattern.test(value) ? value : null;
}

/** A valid calendar day "YYYY-MM-DD", or null. */
export function activityDay(value: unknown): string | null {
  const day = typeof value === "string" ? value : first(value);
  if (!day || !DAY_PATTERN.test(day)) return null;
  try {
    // parseDate accepts "2026-02-30"; a real day prints back the same.
    return parseDate(day).toString() === day ? day : null;
  } catch {
    return null;
  }
}

/** The instant a day starts in the assemblies' time zone, as ISO. */
export function activityDayStart(day: string): string {
  return toZoned(parseDate(day), ASSEMBLY_TIME_ZONE).toAbsoluteString();
}

/** The instant the day after `day` starts: the exclusive end of `day`. */
export function activityDayEnd(day: string): string {
  return toZoned(
    parseDate(day).add({ days: 1 }),
    ASSEMBLY_TIME_ZONE,
  ).toAbsoluteString();
}

/**
 * `from`/`to` days for the API: the earlier day starts the range and the
 * later one ends it (an inverted pair would be refused with a 400).
 */
export function activityDateRange(
  from: string | null,
  to: string | null,
): { from?: string; to?: string } {
  const [start, end] = from && to && from > to ? [to, from] : [from, to];
  return {
    from: start ? activityDayStart(start) : undefined,
    to: end ? activityDayEnd(end) : undefined,
  };
}

function compact(query: Record<string, string | undefined>): ActivityApiQuery {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== undefined),
  );
}

// "Mi actividad" ------------------------------------------------------------

export interface MeActivityFilters {
  tab: MeActivityTab;
  /** Assembly slug or id. */
  assembly: string | null;
  category: ActivityCategory | null;
  /** Days, inclusive. */
  from: string | null;
  to: string | null;
}

/**
 * The categories each tab offers in its filter, in the order shown. The
 * accesses tab has nothing to tell apart, so it offers none.
 */
export const ME_ACTIVITY_TAB_CATEGORIES: Record<
  MeActivityTab,
  readonly ActivityCategory[]
> = {
  by: [
    "document",
    "amendment",
    "session",
    "agenda",
    "assembly",
    "export",
    "account",
    "roles",
    "member",
    "access",
  ],
  to: ["account", "roles", "access"],
  access: [],
  member: ["document", "amendment", "session", "agenda", "assembly", "export"],
};

/** Tabs whose items belong to assemblies, so the assembly filter applies. */
export function meActivityTabHasAssemblies(tab: MeActivityTab): boolean {
  return tab === "by" || tab === "member";
}

function isTab(value: string | undefined): value is MeActivityTab {
  return (ME_ACTIVITY_TABS as readonly string[]).includes(value ?? "");
}

function isCategory(value: string | undefined): value is ActivityCategory {
  return (ACTIVITY_CATEGORIES as readonly string[]).includes(value ?? "");
}

function isSource(value: string | undefined): value is AuditSource {
  return (AUDIT_SOURCES as readonly string[]).includes(value ?? "");
}

/**
 * The filters in the URL. The member tab needs a linked member, so without
 * one it falls back to the first tab; a filter the tab does not offer is
 * dropped.
 */
export function parseMeActivityQuery(
  query: ActivityRouteQuery,
  options: { hasMember: boolean },
): MeActivityFilters {
  const rawTab = first(query.tab);
  const tab: MeActivityTab =
    isTab(rawTab) && (rawTab !== "member" || options.hasMember) ? rawTab : "by";
  const rawCategory = first(query.category);
  const category =
    isCategory(rawCategory) &&
    ME_ACTIVITY_TAB_CATEGORIES[tab].includes(rawCategory)
      ? rawCategory
      : null;
  return {
    tab,
    assembly: meActivityTabHasAssemblies(tab)
      ? matching(first(query.assembly), ASSEMBLY_REF_PATTERN)
      : null,
    category,
    from: activityDay(query.from),
    to: activityDay(query.to),
  };
}

/** The URL query of these filters (defaults left out). */
export function meActivityRouteQuery(
  filters: MeActivityFilters,
): Record<string, string | undefined> {
  return {
    tab: filters.tab === "by" ? undefined : filters.tab,
    assembly: filters.assembly ?? undefined,
    category: filters.category ?? undefined,
    from: filters.from ?? undefined,
    to: filters.to ?? undefined,
  };
}

/** GET /api/me/activity query (without the cursor). */
export function meActivityApiQuery(
  filters: MeActivityFilters,
): ActivityApiQuery {
  return compact({
    tab: filters.tab,
    assembly: filters.assembly ?? undefined,
    category: filters.category ?? undefined,
    ...activityDateRange(filters.from, filters.to),
  });
}

/** Whether any filter besides the tab is set. */
export function meActivityHasFilters(filters: MeActivityFilters): boolean {
  return Boolean(
    filters.assembly || filters.category || filters.from || filters.to,
  );
}

// Admin log -----------------------------------------------------------------

export const ADMIN_ACTIVITY_VIEWS = ["log", "impersonations"] as const;
export type AdminActivityView = (typeof ADMIN_ACTIVITY_VIEWS)[number];

export const ADMIN_IMPERSONATION_STATES = ["all", "active", "ended"] as const;
export type AdminImpersonationState =
  (typeof ADMIN_IMPERSONATION_STATES)[number];

export interface AdminActivityFilters {
  view: AdminActivityView;
  /** Done by or to this account (better-auth user id). */
  user: string | null;
  member: string | null;
  /** Assembly slug or id. */
  assembly: string | null;
  category: ActivityCategory[];
  source: AuditSource[];
  /** Only what was done while an Admin acted as someone. */
  impersonated: boolean;
  /** Only what was done under this impersonation. */
  impersonation: string | null;
  from: string | null;
  to: string | null;
  /** Impersonations view: open ones, ended ones or all. */
  state: AdminImpersonationState;
}

export function emptyAdminActivityFilters(
  view: AdminActivityView = "log",
): AdminActivityFilters {
  return {
    view,
    user: null,
    member: null,
    assembly: null,
    category: [],
    source: [],
    impersonated: false,
    impersonation: null,
    from: null,
    to: null,
    state: "all",
  };
}

export function parseAdminActivityQuery(
  query: ActivityRouteQuery,
): AdminActivityFilters {
  const view = first(query.view);
  const state = first(query.state);
  const impersonated = first(query.impersonated);
  return {
    view: view === "impersonations" ? "impersonations" : "log",
    user: matching(first(query.user), USER_ID_PATTERN),
    member: matching(first(query.member), ENTITY_ID_PATTERN),
    assembly: matching(first(query.assembly), ASSEMBLY_REF_PATTERN),
    category: list(query.category).filter(isCategory),
    source: list(query.source).filter(isSource),
    impersonated: impersonated === "1" || impersonated === "true",
    impersonation: matching(first(query.impersonation), ENTITY_ID_PATTERN),
    from: activityDay(query.from),
    to: activityDay(query.to),
    state:
      state === "active" || state === "ended"
        ? (state as AdminImpersonationState)
        : "all",
  };
}

export function adminActivityRouteQuery(
  filters: AdminActivityFilters,
): Record<string, string | undefined> {
  return {
    view: filters.view === "log" ? undefined : filters.view,
    user: filters.user ?? undefined,
    member: filters.member ?? undefined,
    assembly: filters.assembly ?? undefined,
    category: filters.category.join(",") || undefined,
    source: filters.source.join(",") || undefined,
    impersonated: filters.impersonated ? "1" : undefined,
    impersonation: filters.impersonation ?? undefined,
    from: filters.from ?? undefined,
    to: filters.to ?? undefined,
    state: filters.state === "all" ? undefined : filters.state,
  };
}

/** GET /api/admin/activity query (without the cursor). */
export function adminActivityApiQuery(
  filters: AdminActivityFilters,
): ActivityApiQuery {
  return compact({
    user: filters.user ?? undefined,
    member: filters.member ?? undefined,
    assembly: filters.assembly ?? undefined,
    category: filters.category.join(",") || undefined,
    source: filters.source.join(",") || undefined,
    impersonated: filters.impersonated ? "1" : undefined,
    impersonation: filters.impersonation ?? undefined,
    ...activityDateRange(filters.from, filters.to),
  });
}

/**
 * GET /api/admin/impersonations query (without the cursor). The account
 * filter of the log names the account acted as here: an Admin is never one.
 */
export function adminImpersonationApiQuery(
  filters: AdminActivityFilters,
): ActivityApiQuery {
  return compact({
    target: filters.user ?? undefined,
    active:
      filters.state === "active"
        ? "1"
        : filters.state === "ended"
          ? "0"
          : undefined,
  });
}

/** How many log filters are set (the view and the impersonations state aside). */
export function adminActivityFilterCount(
  filters: AdminActivityFilters,
): number {
  return [
    filters.user,
    filters.member,
    filters.assembly,
    filters.category.length > 0,
    filters.source.length > 0,
    filters.impersonated,
    filters.impersonation,
    filters.from,
    filters.to,
  ].filter(Boolean).length;
}
