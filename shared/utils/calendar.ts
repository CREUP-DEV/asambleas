import { fromDate, toCalendarDateTime } from "@internationalized/date";
import type { DocumentKind, MilestoneKey } from "../constants/domain";
import { MILESTONE_KEYS, REGULATION_DOCUMENT_KINDS } from "../constants/domain";

/** The assemblies' time zone: every date is set and shown in it. */
export const ASSEMBLY_TIME_ZONE = "Europe/Madrid";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How long before the assembly start a milestone falls: whole days or
 * calendar months in the assemblies' time zone (same wall-clock time, also
 * across a clock change) or exact hours (the regulation's "96 horas").
 */
export type MilestoneOffset =
  { days: number } | { hours: number } | { months: number };

/**
 * The calendar rules of one assembly type, stored in `calendar_rules` and
 * edited in the admin section (the regulations change often, so none of
 * this is fixed in code). `defaults` fill a new calendar; the rest only
 * warns (checkCalendar), since every date stays editable per assembly.
 */
export interface CalendarRules {
  /** Offsets before the start that "Apply default deadlines" proposes. */
  defaults: Partial<Record<MilestoneKey, MilestoneOffset>>;
  /**
   * Regulatory minimums: each milestone must fall at least this long before
   * the start (the convocation's notice, the final agenda, the documents,
   * the latest the amendment window may be extended to...).
   */
  minimums: Partial<Record<MilestoneKey, MilestoneOffset>>;
  /**
   * An assembly convened with less notice than this must send every
   * document with the convocation, or the convocation is not valid (RRI
   * art. 13.1.a, extraordinary assemblies): the documents must be published
   * no later than the convocation. null: no such rule for the type.
   */
  documentsWithConvocationBelow: MilestoneOffset | null;
  /**
   * Shortest amendment window, in days, of a reform of the Estatutos or a
   * regulation (REGULATION_DOCUMENT_KINDS, RRI art. 65.3): its own window,
   * else the assembly's. null: no minimum.
   */
  regulationWindowDays: number | null;
}

/** The instant `offset` before `start`. */
export function milestoneOffsetBefore(
  start: Date,
  offset: MilestoneOffset,
): Date {
  if ("hours" in offset) return new Date(start.getTime() - offset.hours * HOUR);
  if (Number.isNaN(start.getTime())) return new Date(Number.NaN);
  const zoned = fromDate(start, ASSEMBLY_TIME_ZONE);
  // A month back from the 31st lands on the last day of the shorter month
  // (31 March -> 28 or 29 February): the notice is never less than a month.
  if ("months" in offset) {
    return zoned.subtract({ months: offset.months }).toDate();
  }
  return zoned.subtract({ days: offset.days }).toDate();
}

/**
 * Whole days from `at` to `start` when both fall at the same wall-clock time
 * in the assemblies' time zone, or null. A 2-day deadline across a clock
 * change lasts 47 or 49 hours, and still reads as 2 days.
 */
export function wholeDaysBeforeStart(start: Date, at: Date): number | null {
  if (Number.isNaN(start.getTime()) || Number.isNaN(at.getTime())) return null;
  const from = toCalendarDateTime(fromDate(at, ASSEMBLY_TIME_ZONE));
  const to = toCalendarDateTime(fromDate(start, ASSEMBLY_TIME_ZONE));
  if (
    from.hour !== to.hour ||
    from.minute !== to.minute ||
    from.second !== to.second ||
    from.millisecond !== to.millisecond
  ) {
    return null;
  }
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) -
      Date.UTC(from.year, from.month - 1, from.day)) /
      DAY,
  );
}

export type Milestones = Partial<Record<MilestoneKey, Date>>;

/** The calendar the rules propose for an assembly starting at `start`. */
export function defaultMilestones(
  rules: Pick<CalendarRules, "defaults">,
  start: Date,
): Milestones {
  const result: Milestones = {};
  for (const key of MILESTONE_KEYS) {
    const offset = rules.defaults[key];
    if (offset !== undefined) {
      result[key] = milestoneOffsetBefore(start, offset);
    }
  }
  return result;
}

export type CalendarWarningCode =
  | "short_notice"
  | "below_minimum"
  | "documents_not_with_convocation"
  | "regulation_window_short"
  | "amendments_before_publication"
  | "amendments_close_before_open"
  | "amendments_overlap_documents"
  | "after_start"
  | "agenda_after_publication";

export interface CalendarWarning {
  code: CalendarWarningCode;
  keys: MilestoneKey[];
  /**
   * The rule broken (`short_notice`, `below_minimum`,
   * `documents_not_with_convocation`).
   */
  limit?: MilestoneOffset;
  /** The minimum window in days (`regulation_window_short`). */
  days?: number;
  /** The document whose window is too short (`regulation_window_short`). */
  document?: { id: string; title: string };
}

/**
 * A document of the assembly as the calendar check needs it: its kind and
 * its own amendment window, which overrides the assembly's when set.
 */
export interface CalendarDocument {
  id: string;
  title: string;
  kind: DocumentKind;
  amendable: boolean;
  amendmentsOpenAt: Date | string | null;
  amendmentsCloseAt: Date | string | null;
}

/**
 * Flags calendars that break a regulatory minimum of `rules` or contradict
 * themselves. `documents` adds the reform window check for the amendable
 * regulation and statutes documents among them.
 */
export function checkCalendar(
  rules: CalendarRules,
  start: Date,
  milestones: Milestones,
  documents: readonly CalendarDocument[] = [],
): CalendarWarning[] {
  const warnings: CalendarWarning[] = [];
  const at = (key: MilestoneKey) => milestones[key]?.getTime();
  for (const key of MILESTONE_KEYS) {
    const limit = rules.minimums[key];
    const value = at(key);
    if (limit === undefined || value === undefined) continue;
    // Counted in the assemblies' time zone, like the defaults, so a clock
    // change in between neither adds nor removes an hour of notice.
    if (value > milestoneOffsetBefore(start, limit).getTime()) {
      warnings.push({
        code: key === "convocation" ? "short_notice" : "below_minimum",
        keys: [key],
        limit,
      });
    }
  }

  const convocation = at("convocation");
  const publish = at("documents_publish");
  const attachBelow = rules.documentsWithConvocationBelow;
  if (
    attachBelow &&
    convocation !== undefined &&
    convocation > milestoneOffsetBefore(start, attachBelow).getTime() &&
    (publish === undefined || publish > convocation)
  ) {
    warnings.push({
      code: "documents_not_with_convocation",
      keys: ["convocation", "documents_publish"],
      limit: attachBelow,
    });
  }

  const open = at("amendments_open");
  const close = at("amendments_close");
  if (open !== undefined && publish !== undefined && open < publish) {
    warnings.push({
      code: "amendments_before_publication",
      keys: ["amendments_open", "documents_publish"],
    });
  }
  if (open !== undefined && close !== undefined && close <= open) {
    warnings.push({
      code: "amendments_close_before_open",
      keys: ["amendments_open", "amendments_close"],
    });
  }
  const documentsClose = at("documents_close");
  if (
    documentsClose !== undefined &&
    close !== undefined &&
    documentsClose >= close
  ) {
    warnings.push({
      code: "amendments_overlap_documents",
      keys: ["documents_close", "amendments_close"],
    });
  }
  const agendaFinal = at("agenda_final");
  if (
    agendaFinal !== undefined &&
    publish !== undefined &&
    agendaFinal > publish
  ) {
    warnings.push({
      code: "agenda_after_publication",
      keys: ["agenda_final", "documents_publish"],
    });
  }

  const windowDays = rules.regulationWindowDays;
  if (windowDays !== null) {
    for (const document of documents) {
      if (
        !document.amendable ||
        !REGULATION_DOCUMENT_KINDS.includes(document.kind)
      ) {
        continue;
      }
      const window = amendmentWindow(document, milestones);
      if (!window.opensAt || !window.closesAt) continue;
      const shortestClose = milestoneOffsetBefore(window.closesAt, {
        days: windowDays,
      });
      if (window.opensAt.getTime() > shortestClose.getTime()) {
        warnings.push({
          code: "regulation_window_short",
          keys: ["amendments_open", "amendments_close"],
          days: windowDays,
          document: { id: document.id, title: document.title },
        });
      }
    }
  }

  for (const key of MILESTONE_KEYS) {
    const value = at(key);
    if (value !== undefined && value > start.getTime()) {
      warnings.push({ code: "after_start", keys: [key] });
    }
  }
  return warnings;
}

export interface AmendmentWindow {
  opensAt: Date | null;
  closesAt: Date | null;
}

/** The window that applies to a document: its own override or the assembly's. */
export function amendmentWindow(
  document: {
    amendmentsOpenAt: Date | string | null;
    amendmentsCloseAt: Date | string | null;
  },
  milestones: Milestones,
): AmendmentWindow {
  const toDate = (value: Date | string | null | undefined) =>
    value ? new Date(value) : null;
  return {
    opensAt:
      toDate(document.amendmentsOpenAt) ?? milestones.amendments_open ?? null,
    closesAt:
      toDate(document.amendmentsCloseAt) ?? milestones.amendments_close ?? null,
  };
}

export function isWindowOpen(
  window: AmendmentWindow,
  now = new Date(),
): boolean {
  if (window.opensAt && now < window.opensAt) return false;
  if (window.closesAt && now > window.closesAt) return false;
  return true;
}

export function isLateSubmission(
  window: AmendmentWindow,
  at = new Date(),
): boolean {
  return Boolean(window.closesAt && at > window.closesAt);
}
