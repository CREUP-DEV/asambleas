import type { AssemblyType } from "../constants/assemblyTypes";
import type { MilestoneKey } from "../constants/domain";
import { MILESTONE_KEYS } from "../constants/domain";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Default offsets before the assembly start (RFAG and RRI 2026, see
 * docs/proceso-asambleas.md §3). Every value stays editable per assembly.
 */
export const DEFAULT_MILESTONE_OFFSETS: Record<
  AssemblyType,
  Partial<Record<MilestoneKey, number>>
> = {
  AGO: {
    convocation: 30 * DAY,
    agenda_requests_close: 21 * DAY,
    agenda_final: 14 * DAY,
    documents_publish: 12 * DAY,
    amendments_open: 12 * DAY,
    documents_close: 8 * DAY,
    amendments_close: 4 * DAY,
    candidacies_close: 96 * HOUR,
  },
  AGE: {
    convocation: 15 * DAY,
    agenda_final: 7 * DAY,
    documents_publish: 5 * DAY,
    amendments_open: 5 * DAY,
    amendments_close: 2 * DAY,
    candidacies_close: 48 * HOUR,
  },
  AGET: {
    convocation: 7 * DAY,
    agenda_final: 7 * DAY,
    documents_publish: 5 * DAY,
    amendments_open: 5 * DAY,
    amendments_close: 2 * DAY,
  },
};

/** Regulatory minimum notice of the convocation, by type. */
export const MINIMUM_NOTICE: Record<AssemblyType, number> = {
  AGO: 30 * DAY,
  AGE: 15 * DAY,
  AGET: 5 * DAY,
};

export type Milestones = Partial<Record<MilestoneKey, Date>>;

export function defaultMilestones(type: AssemblyType, start: Date): Milestones {
  const result: Milestones = {};
  for (const key of MILESTONE_KEYS) {
    const offset = DEFAULT_MILESTONE_OFFSETS[type][key];
    if (offset !== undefined) result[key] = new Date(start.getTime() - offset);
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

  const convocation = at("convocation");
  if (
    convocation !== undefined &&
    start.getTime() - convocation < MINIMUM_NOTICE[type]
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
