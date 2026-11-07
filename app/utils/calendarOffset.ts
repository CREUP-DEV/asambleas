import type { MilestoneOffset } from "~~/shared/utils/calendar";

type Translate = (
  key: string,
  named: Record<string, unknown>,
  plural: number,
) => string;

/** "1 mes", "14 días", "72 horas": a calendar rule offset, in the UI language. */
export function formatMilestoneOffset(
  t: Translate,
  offset: MilestoneOffset,
): string {
  if ("months" in offset) {
    return t("calendar.offset.months", { count: offset.months }, offset.months);
  }
  if ("hours" in offset) {
    return t("calendar.offset.hours", { count: offset.hours }, offset.hours);
  }
  return t("calendar.offset.days", { count: offset.days }, offset.days);
}
