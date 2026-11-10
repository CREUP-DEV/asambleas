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
import { ASSEMBLY_TIME_ZONE } from "~~/shared/utils/calendar";

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

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/**
 * "dentro de 3 días", "hace 2 horas", "mañana". The smallest unit defaults
 * to minutes, so values closer than a minute read as "este minuto".
 * `maxUnit: "day"` counts days instead of weeks, months or years, so
 * deadlines a few days apart do not all read "el próximo mes".
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
  let formatter = relativeCache.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeCache.set(locale, formatter);
  }

  for (const [unit, size] of RELATIVE_UNITS) {
    if (options.maxUnit === "day" && size > 24 * 3600) continue;
    if (unit === "second" && minUnit === "minute") break;
    if (absolute >= size) {
      // Days and above round to the nearest unit; shorter units truncate so a
      // countdown never claims more time than is left.
      const amount =
        size >= 24 * 3600
          ? Math.round(seconds / size)
          : Math.trunc(seconds / size);
      return formatter.format(amount, unit);
    }
  }
  return formatter.format(0, minUnit);
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
