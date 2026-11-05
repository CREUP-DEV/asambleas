import { fromDate, toCalendarDateTime } from "@internationalized/date";
import type { AssemblyType } from "../constants/assemblyTypes";
import type { MilestoneKey } from "../constants/domain";
import { MILESTONE_KEYS } from "../constants/domain";

/** The assemblies' time zone: every date is set and shown in it. */
export const ASSEMBLY_TIME_ZONE = "Europe/Madrid";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How long before the assembly start a milestone falls: whole days in the
 * assemblies' time zone (same wall-clock time, also across a clock change)
 * or exact hours (the regulation's "96 horas").
 */
export type MilestoneOffset = { days: number } | { hours: number };

/**
 * Default offsets before the assembly start (RFAG and RRI 2026, see
 * docs/proceso-asambleas.md §3). Every value stays editable per assembly.
 */
export const DEFAULT_MILESTONE_OFFSETS: Record<
  AssemblyType,
  Partial<Record<MilestoneKey, MilestoneOffset>>
> = {
  AGO: {
    convocation: { days: 30 },
    agenda_requests_close: { days: 21 },
    agenda_final: { days: 14 },
    documents_publish: { days: 12 },
    amendments_open: { days: 12 },
    documents_close: { days: 8 },
    amendments_close: { days: 4 },
    candidacies_close: { hours: 96 },
  },
  AGE: {
    convocation: { days: 15 },
    agenda_final: { days: 7 },
    documents_publish: { days: 5 },
    amendments_open: { days: 5 },
    amendments_close: { days: 2 },
    candidacies_close: { hours: 48 },
  },
  AGET: {
    convocation: { days: 7 },
    agenda_final: { days: 7 },
    documents_publish: { days: 5 },
    amendments_open: { days: 5 },
    amendments_close: { days: 2 },
  },
};

/** Regulatory minimum notice of the convocation, in days, by type. */
export const MINIMUM_NOTICE_DAYS: Record<AssemblyType, number> = {
  AGO: 30,
  AGE: 15,
  AGET: 5,
};

/** The instant `offset` before `start`. */
export function milestoneOffsetBefore(
  start: Date,
  offset: MilestoneOffset,
): Date {
  if ("hours" in offset) return new Date(start.getTime() - offset.hours * HOUR);
  if (Number.isNaN(start.getTime())) return new Date(Number.NaN);
  return fromDate(start, ASSEMBLY_TIME_ZONE)
    .subtract({ days: offset.days })
    .toDate();
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

export function defaultMilestones(type: AssemblyType, start: Date): Milestones {
  const result: Milestones = {};
  for (const key of MILESTONE_KEYS) {
    const offset = DEFAULT_MILESTONE_OFFSETS[type][key];
    if (offset !== undefined) {
      result[key] = milestoneOffsetBefore(start, offset);
    }
  }
  return result;
}

export type CalendarWarningCode =
  | "short_notice"
  | "amendments_before_publication"
  | "amendments_close_before_open"
  | "amendments_overlap_documents"
  | "after_start"
  | "agenda_after_publication";

export interface CalendarWarning {
  code: CalendarWarningCode;
  keys: MilestoneKey[];
}

/** Flags calendars that break a regulatory minimum or contradict themselves. */
export function checkCalendar(
  type: AssemblyType,
  start: Date,
  milestones: Milestones,
): CalendarWarning[] {
  const warnings: CalendarWarning[] = [];
  const at = (key: MilestoneKey) => milestones[key]?.getTime();

  // Counted in days in the assemblies' time zone, like the defaults, so a
  // clock change in between neither adds nor removes an hour of notice.
  const convocation = at("convocation");
  if (
    convocation !== undefined &&
    convocation >
      milestoneOffsetBefore(start, {
        days: MINIMUM_NOTICE_DAYS[type],
      }).getTime()
  ) {
    warnings.push({ code: "short_notice", keys: ["convocation"] });
  }

  const open = at("amendments_open");
  const close = at("amendments_close");
  const publish = at("documents_publish");
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
