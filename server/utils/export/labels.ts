import esMessages from "../../../i18n/locales/es.json";
import enMessages from "../../../i18n/locales/en.json";
import type { FormatChange } from "../../../shared/types/content";
import {
  EXPORT_LOCALES,
  type ExportLocale,
} from "../../../shared/utils/schemas/export";
import {
  ASSEMBLY_INTL_LOCALES,
  assemblyDateFormatter,
  assemblyDayKey,
  formatLongDate,
} from "../../../shared/utils/dates";

/**
 * Server-side labels for PDF exports. The worker has no request and no
 * vue-i18n instance, so it reads the `export.pdf` namespace of the locale
 * files directly. Only `{name}` placeholders are supported.
 */

export { EXPORT_LOCALES, type ExportLocale };

/** The Intl locale of each export locale (the platform's own table). */
export const EXPORT_INTL_LOCALES: Readonly<Record<ExportLocale, string>> =
  ASSEMBLY_INTL_LOCALES;

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
 * Any key of the locale files by its full path, falling back to Spanish:
 * for a PDF that says what a page of the platform says (the generated
 * convocatoria reads `convocation.*`), so the two never drift apart.
 */
export function createAppTranslator(locale: ExportLocale): Translate {
  return (key, params) => {
    const message =
      lookup(MESSAGES[locale], key) ?? lookup(MESSAGES.es, key) ?? key;
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

/** «21 de noviembre de 2026» / «21 November 2026», in Madrid. */
export function formatExportDate(date: Date, locale: ExportLocale): string {
  return formatLongDate(date, EXPORT_INTL_LOCALES[locale]);
}

/** «21 de noviembre de 2026 a las 16:40» / «21 November 2026 at 16:40». */
export function formatExportDateTime(date: Date, locale: ExportLocale): string {
  return assemblyDateFormatter(EXPORT_INTL_LOCALES[locale], {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

/** "del 19 al 21 de noviembre" style ranges without Intl's en dash. */
export function formatExportDateRange(
  start: Date,
  end: Date,
  locale: ExportLocale,
  t: Translate,
): string {
  if (assemblyDayKey(start) === assemblyDayKey(end))
    return formatExportDate(start, locale);
  return t("dateRange", {
    start: formatExportDate(start, locale),
    end: formatExportDate(end, locale),
  });
}
