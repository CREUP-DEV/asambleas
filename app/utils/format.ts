/**
 * Date and time formatting for the UI. Every value is shown in the
 * assemblies' time zone (Europe/Madrid), whatever the viewer's device says,
 * and in the active i18n locale unless one is passed explicitly.
 */

import {
  fromDate,
  toCalendarDateTime,
  toZoned,
  type CalendarDateTime,
  type DateValue,
} from "@internationalized/date";
import {
  ASSEMBLY_TIME_ZONE,
  assemblyDayOffset,
} from "~~/shared/utils/calendar";

export const APP_TIME_ZONE = ASSEMBLY_TIME_ZONE;

export type DateInput = Date | string | number | null | undefined;

const INTL_LOCALES: Record<string, string> = {
  es: "es-ES",
  en: "en-GB",
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const relativeCache = new Map<string, Intl.RelativeTimeFormat>();

/** The Intl locale for an app locale code ("es" -> "es-ES"). */
export function intlLocale(locale?: string): string {
  const code = locale ?? activeLocale();
  return INTL_LOCALES[code] ?? code;
}

function activeLocale(): string {
  const i18n = tryUseNuxtApp()?.$i18n as
    { locale?: { value?: string } } | undefined;
  return i18n?.locale?.value ?? "es";
}

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone: APP_TIME_ZONE,
      ...options,
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export interface FormatOptions {
  /** App locale code ("es", "en"). Defaults to the active i18n locale. */
  locale?: string;
}

/** "14 de noviembre de 2026" / "14 November 2026". */
export function formatDate(
  value: DateInput,
  options: FormatOptions & { style?: "long" | "medium" | "short" } = {},
): string {
  const date = toDate(value);
  if (!date) return "";
  const style = options.style ?? "long";
  const intlOptions: Intl.DateTimeFormatOptions =
    style === "short"
      ? { day: "2-digit", month: "2-digit", year: "numeric" }
      : style === "medium"
        ? { day: "numeric", month: "short", year: "numeric" }
        : { day: "numeric", month: "long", year: "numeric" };
  return dateFormatter(intlLocale(options.locale), intlOptions).format(date);
}

/** "14 nov 2026, 10:30" / "14 Nov 2026, 10:30". */
export function formatDateTime(
  value: DateInput,
  options: FormatOptions & { style?: "long" | "medium" | "short" } = {},
): string {
  const date = toDate(value);
  if (!date) return "";
  const style = options.style ?? "medium";
  const intlOptions: Intl.DateTimeFormatOptions =
    style === "short"
      ? {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }
      : {
          day: "numeric",
          month: style === "long" ? "long" : "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        };
  return dateFormatter(intlLocale(options.locale), intlOptions).format(date);
}

/** "10:30". */
export function formatTime(
  value: DateInput,
  options: FormatOptions = {},
): string {
  const date = toDate(value);
  if (!date) return "";
  return dateFormatter(intlLocale(options.locale), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * A past moment such as a headcount, with its day only when it is not today
 * in the assemblies' time zone: "18:45" today, "ayer, 18:45" yesterday,
 * "17 nov 2026, 18:45" before. `today` says which, so a sentence can choose
 * its wording ("del recuento de las 18:45" against "del recuento de ayer,
 * 18:45") and a view can warn when a count is from another day.
 */
export function formatMoment(
  value: DateInput,
  options: FormatOptions & { now?: DateInput } = {},
): { text: string; today: boolean; dayOffset: number } {
  const date = toDate(value);
  if (!date) return { text: "", today: false, dayOffset: Number.NaN };
  const now = toDate(options.now) ?? new Date();
  const dayOffset = assemblyDayOffset(date, now);
  const time = formatTime(date, options);
  if (dayOffset === 0) return { text: time, today: true, dayOffset };
  if (dayOffset === -1) {
    const yesterday = relativeFormatter(
      intlLocale(options.locale),
      "auto",
    ).format(-1, "day");
    return {
      text: `${yesterday}, ${time}`,
      today: false,
      dayOffset,
    };
  }
  return {
    text: formatDateTime(date, options),
    today: false,
    dayOffset,
  };
}

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/** Hours and shorter: these truncate, so a countdown never claims more. */
const CLOCK_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["hour", HOUR_SECONDS],
  ["minute", 60],
  ["second", 1],
];

/**
 * A cached relative formatter. `auto` words days ("mañana", "ayer"), which
 * count calendar days here; weeks, months and years use `always` ("dentro de
 * 2 semanas"), since "la próxima semana" or "el próximo mes" would name a
 * calendar week or month that a count of days does not give.
 */
function relativeFormatter(
  locale: string,
  numeric: "auto" | "always",
): Intl.RelativeTimeFormat {
  const key = numeric === "auto" ? locale : `${locale}|always`;
  let formatter = relativeCache.get(key);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric });
    relativeCache.set(key, formatter);
  }
  return formatter;
}

/**
 * "dentro de 3 días", "hace 2 horas", "mañana". Within 24 hours it counts
 * hours and minutes, truncated so a countdown never claims more time than is
 * left; the smallest unit defaults to minutes, so values closer than a minute
 * read as "este minuto". From 24 hours on it counts calendar days in the
 * assemblies' time zone, whatever the hours: a deadline at 23:59 tomorrow
 * reads "mañana" even 40 hours ahead, never "pasado mañana". Weeks start at
 * 14 days, months at 30 and years at 365, each truncated ("dentro de 2
 * semanas" for 20 days). `maxUnit: "day"` keeps counting days instead
 * ("dentro de 35 días"), so deadlines a few days apart stay apart.
 */
export function formatRelative(
  value: DateInput,
  options: FormatOptions & {
    now?: DateInput;
    minUnit?: "second" | "minute";
    maxUnit?: "day";
  } = {},
): string {
  const date = toDate(value);
  if (!date) return "";
  const now = toDate(options.now) ?? new Date();
  const seconds = (date.getTime() - now.getTime()) / 1000;
  const absolute = Math.abs(seconds);
  const minUnit = options.minUnit ?? "minute";
  const locale = intlLocale(options.locale);
  const auto = relativeFormatter(locale, "auto");

  // On the day the clocks go back, 24 hours may still be the same day: that
  // one stays in hours rather than read "hoy".
  const days = absolute >= DAY_SECONDS ? assemblyDayOffset(date, now) : 0;
  if (days !== 0 && Number.isFinite(days)) {
    const count = Math.abs(days);
    const sign = Math.sign(days);
    if (options.maxUnit !== "day") {
      const always = relativeFormatter(locale, "always");
      if (count >= 365) {
        return always.format(sign * Math.trunc(count / 365), "year");
      }
      if (count >= 30) {
        return always.format(sign * Math.trunc(count / 30), "month");
      }
      if (count >= 14) {
        return always.format(sign * Math.trunc(count / 7), "week");
      }
    }
    return auto.format(days, "day");
  }

  for (const [unit, size] of CLOCK_UNITS) {
    if (unit === "second" && minUnit === "minute") break;
    if (absolute >= size) return auto.format(Math.trunc(seconds / size), unit);
  }
  return auto.format(0, minUnit);
}

/**
 * "19 nov" / "19 Nov", with the year only when it is not the year of `now`
 * ("19 nov 2027"): a deadline's day next to a countdown.
 */
export function formatDayMonth(
  value: DateInput,
  options: FormatOptions & { now?: DateInput } = {},
): string {
  const date = toDate(value);
  if (!date) return "";
  const now = toDate(options.now) ?? new Date();
  const locale = intlLocale(options.locale);
  const year = dateFormatter(locale, { year: "numeric" });
  const sameYear = year.format(date) === year.format(now);
  return dateFormatter(
    locale,
    sameYear
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" },
  ).format(date);
}

/**
 * An instant as wall time in the assemblies' time zone, the value of the
 * date-time fields (undefined when empty or invalid).
 */
export function toAppWallTime(value: DateInput): CalendarDateTime | undefined {
  const date = toDate(value);
  return date ? toCalendarDateTime(fromDate(date, APP_TIME_ZONE)) : undefined;
}

/** Wall time in the assemblies' time zone back to an ISO instant. */
export function fromAppWallTime(
  value: DateValue | null | undefined,
): string | null {
  return value ? toZoned(value, APP_TIME_ZONE).toAbsoluteString() : null;
}

interface MemberNames {
  acronym: string;
  name: string;
}

/**
 * Whether a member's name only repeats its acronym (or is empty). Executive
 * areas created on a CEA sign-in start named after their acronym, so showing
 * both would read "VDT · VDT".
 */
export function memberNameRepeatsAcronym(member: MemberNames): boolean {
  const name = member.name.trim().toLowerCase();
  return name === "" || name === member.acronym.trim().toLowerCase();
}

/** "PRES · Presidencia", or just "VDT" when the name repeats the acronym. */
export function memberLabel(member: MemberNames): string {
  return memberNameRepeatsAcronym(member)
    ? member.acronym
    : `${member.acronym} · ${member.name.trim()}`;
}

/**
 * What a member is called under its acronym in a menu, as the headcount
 * names it: its denomination (unless it repeats the acronym) and, if any,
 * its university. "Consejo de Estudiantes · Universidad de Murcia".
 */
export function memberDescription(
  member: MemberNames & { university?: string | null },
): string | undefined {
  const name = memberNameRepeatsAcronym(member) ? "" : member.name.trim();
  const full = [name, member.university?.trim()].filter(Boolean).join(" · ");
  return full || undefined;
}

/**
 * A member as an item of a menu that picks members (who presents a
 * document, the authors of an amendment): its acronym, then its whole
 * denomination and university below, never cut (MEMBER_MENU_UI).
 */
export function memberMenuItem(
  member: MemberNames & { id: string; university?: string | null },
): {
  label: string;
  description: string | undefined;
  value: string;
  /** Shown once chosen ("VGC · Vocalía de …", MenuValue). */
  chosen: string;
} {
  return {
    label: member.acronym,
    chosen: memberLabel(member),
    description: memberDescription(member),
    value: member.id,
  };
}

/** Menu items that wrap instead of cutting a long name (`ui` of the menu). */
export const MEMBER_MENU_UI = {
  itemLabel: "whitespace-normal break-words",
  itemDescription: "whitespace-normal break-words text-muted",
} as const;

/** The fields a member menu searches: the acronym, the name, the university. */
export const MEMBER_MENU_FILTER_FIELDS = ["label", "description"];
