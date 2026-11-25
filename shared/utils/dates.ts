import { fromDate, toCalendarDateTime } from "@internationalized/date";
import { ASSEMBLY_TIME_ZONE } from "./calendar";

/**
 * Date formatting shared by the client, the server and `shared/`: always in
 * the assemblies' time zone (ASSEMBLY_TIME_ZONE) and with an explicit Intl
 * locale, since `shared/` and the export worker have no active i18n locale.
 * `app/utils/format.ts` adds the viewer's locale on top; nothing formats a
 * date with a loose `Intl.DateTimeFormat`.
 */

/** The Intl locale of each app locale: Spain's Spanish, British English. */
export const ASSEMBLY_INTL_LOCALES: Readonly<Record<"es" | "en", string>> = {
  es: "es-ES",
  en: "en-GB",
};

/** The Intl locale for an app locale code ("es" -> "es-ES"), else the code. */
export function toIntlLocale(code: string): string {
  return (
    (ASSEMBLY_INTL_LOCALES as Readonly<Record<string, string>>)[code] ?? code
  );
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter for `intlLocale` in the assemblies' time zone. */
export function assemblyDateFormatter(
  intlLocale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${intlLocale}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(intlLocale, {
      timeZone: ASSEMBLY_TIME_ZONE,
      ...options,
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

const LONG_DATE: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
};

/**
 * The long date in the assemblies' time zone: «21 de noviembre de 2026»
 * (es-ES), «21 November 2026» (en-GB). The date of approved texts, the
 * acta and the exports.
 */
export function formatLongDate(
  value: Date | string | number,
  intlLocale: string,
): string {
  return assemblyDateFormatter(intlLocale, LONG_DATE).format(new Date(value));
}

/** The year of an instant in the assemblies' time zone ("2026"). */
export function assemblyYear(value: Date | string | number): string {
  return String(assemblyWallClock(value).year);
}

/** An instant's wall-clock time in the assemblies' time zone. */
export interface AssemblyWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function assemblyWallClock(
  value: Date | string | number,
): AssemblyWallClock {
  const wall = toCalendarDateTime(
    fromDate(new Date(value), ASSEMBLY_TIME_ZONE),
  );
  return {
    year: wall.year,
    month: wall.month,
    day: wall.day,
    hour: wall.hour,
    minute: wall.minute,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The calendar day of an instant in the assemblies' time zone, "YYYY-MM-DD". */
export function assemblyDayKey(value: Date | string | number): string {
  const { year, month, day } = assemblyWallClock(value);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The hour and minute in the assemblies' time zone, "HHMM" (for file names). */
export function assemblyClockKey(value: Date | string | number): string {
  const { hour, minute } = assemblyWallClock(value);
  return `${pad(hour)}${pad(minute)}`;
}
