import { assemblyDayOffset } from "~~/shared/utils/calendar";
import {
  formatDayMonth,
  formatRelative,
  formatTime,
  toDate,
  type DateInput,
} from "~/utils/format";

/** What CommonCountdown words with `dated`: an i18n key and its params. */
export type DatedCountdown =
  | {
      key: "common.countdown.relativeAt";
      params: { relative: string; time: string };
    }
  | { key: "common.countdown.tomorrowAt"; params: { time: string } }
  | {
      key: "common.countdown.relativeOn";
      params: { relative: string; date: string; time: string };
    };

/**
 * The wording of a countdown that also says when the date falls, for a
 * deadline that matters on the page (CommonCountdown with `dated`): the
 * absolute date must show, not only sit in a tooltip a phone never opens.
 * Pure, so the component and the tests share it; the component words it.
 *
 * - today: the countdown and the time ("dentro de 5 horas, a las 23:59");
 * - tomorrow: the day and the time ("mañana a las 23:59"), however many hours
 *   are left;
 * - further on: the countdown and the date ("dentro de 3 días, el 19 nov a
 *   las 23:59").
 *
 * Days are calendar days in the assemblies' time zone. Null for a date that
 * has passed or is invalid: those keep the plain relative wording.
 */
export function datedCountdown(
  to: DateInput,
  options: { now: DateInput; locale?: string; maxUnit?: "day" },
): DatedCountdown | null {
  const target = toDate(to);
  const now = toDate(options.now);
  if (!target || !now || target.getTime() <= now.getTime()) return null;
  const dayOffset = assemblyDayOffset(target, now);
  const time = formatTime(target, { locale: options.locale });
  if (dayOffset === 1) {
    return { key: "common.countdown.tomorrowAt", params: { time } };
  }
  const relative = formatRelative(target, {
    locale: options.locale,
    now,
    maxUnit: options.maxUnit,
  });
  if (dayOffset <= 0) {
    return { key: "common.countdown.relativeAt", params: { relative, time } };
  }
  return {
    key: "common.countdown.relativeOn",
    params: {
      relative,
      date: formatDayMonth(target, { locale: options.locale, now }),
      time,
    },
  };
}
