import type { MilestoneKey } from "~~/shared/constants/domain";
import type { CalendarWarning } from "~~/shared/utils/calendar";

/**
 * The milestones the calendar warnings touch, each once, in the order they
 * first appear. One warning may name two milestones and two warnings the
 * same one: the overview counts these, as many as the ⚠ of its timeline.
 */
export function warnedMilestoneKeys(
  warnings: readonly Pick<CalendarWarning, "keys">[],
): MilestoneKey[] {
  return [...new Set(warnings.flatMap((warning) => warning.keys))];
}
