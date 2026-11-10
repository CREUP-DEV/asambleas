import esMessages from "../../../i18n/locales/es.json";
import enMessages from "../../../i18n/locales/en.json";
import type { FormatChange } from "../../../shared/types/content";
import {
  EXPORT_LOCALES,
  type ExportLocale,
} from "../../../shared/utils/schemas/export";

/**
 * Server-side labels for PDF exports. The worker has no request and no
 * vue-i18n instance, so it reads the `export.pdf` namespace of the locale
 * files directly. Only `{name}` placeholders are supported.
 */

export { EXPORT_LOCALES, type ExportLocale };

export const EXPORT_INTL_LOCALES: Record<ExportLocale, string> = {
  es: "es-ES",
  en: "en-GB",
};

export const EXPORT_TIME_ZONE = "Europe/Madrid";

type Messages = Record<string, unknown>;

const MESSAGES: Record<ExportLocale, Messages> = {
  es: esMessages as Messages,
  en: enMessages as Messages,
};

const NAMESPACE = "export.pdf";

function lookup(messages: Messages, path: string): string | undefined {
  let node: unknown = messages;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Messages)[part];
  }
  return typeof node === "string" ? node : undefined;
}

export type ExportParams = Record<string, string | number>;
export type Translate = (key: string, params?: ExportParams) => string;

export function interpolate(message: string, params?: ExportParams): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** `t("annex.title")` reads `export.pdf.annex.title`, falling back to Spanish. */
export function createTranslator(locale: ExportLocale): Translate {
  return (key, params) => {
    const path = `${NAMESPACE}.${key}`;
    const message =
      lookup(MESSAGES[locale], path) ?? lookup(MESSAGES.es, path) ?? path;
    return interpolate(message, params);
  };
}

/**
 * What a formatting change does, in words: the labels the platform shows
 * next to it (`common.content.format`), so the PDF reads the same.
 */
export function createFormatLabeller(
  locale: ExportLocale,
): (change: FormatChange) => string {
  return (change) => {
    const path = `common.content.format.${change.code}`;
    const message = lookup(MESSAGES[locale], path) ?? lookup(MESSAGES.es, path);
    return message ? interpolate(message, { value: change.value ?? "" }) : "";
  };
}

export function formatExportDate(date: Date, locale: ExportLocale): string {
  return new Intl.DateTimeFormat(EXPORT_INTL_LOCALES[locale], {
    timeZone: EXPORT_TIME_ZONE,
    dateStyle: "long",
  }).format(date);
}

export function formatExportDateTime(date: Date, locale: ExportLocale): string {
  return new Intl.DateTimeFormat(EXPORT_INTL_LOCALES[locale], {
    timeZone: EXPORT_TIME_ZONE,
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

/** Calendar day in Madrid, to decide whether a range spans one day. */
function madridDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EXPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "del 19 al 21 de noviembre" style ranges without Intl's en dash. */
export function formatExportDateRange(
  start: Date,
  end: Date,
  locale: ExportLocale,
  t: Translate,
): string {
  if (madridDay(start) === madridDay(end))
    return formatExportDate(start, locale);
  return t("dateRange", {
    start: formatExportDate(start, locale),
    end: formatExportDate(end, locale),
  });
}
