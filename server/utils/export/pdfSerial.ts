import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";

/**
 * pdfmake definitions that cross into the render process (pdfRender.ts) as
 * JSON. pdfmake lays a PDF out synchronously, seconds for a long text, so it
 * runs in a separate Node process while the builders (pdfBuilder.ts) stay
 * here: building a definition takes milliseconds.
 *
 * A definition carries functions: the letterhead of every page, the table
 * layouts and the rule that keeps a heading with the text after it. Each is
 * made here from a spec (`pdfFunction`), which the serializer writes in its
 * place and the render process turns back into the same function
 * (PDF_FUNCTIONS_SCRIPT, the one copy of `materialize` outside this file).
 * Anything else JSON cannot carry (an untagged function, a Buffer, a Date, a
 * class instance) makes serializing throw, so a builder change never drops
 * part of a PDF in silence.
 */

/** Where the footer's page count puts the page and the total. */
export const PAGE_NUMBER_MARK = String.fromCharCode(0xe000);
export const PAGE_TOTAL_MARK = String.fromCharCode(0xe001);

export type PdfFunctionSpec =
  /** Returns `value` whatever it is called with (table layouts). */
  | { kind: "constant"; value: string | number | boolean | null }
  /**
   * Returns `values[i]` for the index it is called with, `fallback` past
   * them (the width of a table's i-th rule).
   */
  | { kind: "byIndex"; values: number[]; fallback: number }
  /**
   * A page's background, header or footer: `cover` on the first page when
   * `coverFirst`, `page` on the others, as fresh copies (pdfmake writes into
   * the nodes it gets). Page counts start after `firstPage` pages; a `text`
   * equal to PAGE_NUMBER_MARK or PAGE_TOTAL_MARK takes the number.
   */
  | {
      kind: "page";
      coverFirst: boolean;
      firstPage: number;
      cover: Content | null;
      page: Content | null;
    }
  /** pageBreakBefore: a heading at the foot of a page moves to the next. */
  | { kind: "keepHeadingWithNext" };

/**
 * The styles of the cell of a framed heading (content.ts's headingNode): the
 * burgundy bar of level 1 and the box of level 3.
 */
const FRAMED_HEADING_STYLES: readonly unknown[] = ["barHeading", "boxHeading"];

/** The key the serialized definition writes a function's spec under. */
export const PDF_FUNCTION_KEY = "$pdfFunction";

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const specs = new WeakMap<Function, PdfFunctionSpec>();

function fillPageNumbers(node: unknown, page: number, total: number): void {
  if (Array.isArray(node)) {
    for (const item of node) fillPageNumbers(item, page, total);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (key === "text" && value === PAGE_NUMBER_MARK) {
      record[key] = String(page);
    } else if (key === "text" && value === PAGE_TOTAL_MARK) {
      record[key] = String(total);
    } else {
      fillPageNumbers(value, page, total);
    }
  }
}

function materialize(spec: PdfFunctionSpec) {
  switch (spec.kind) {
    case "constant":
      return () => spec.value;
    case "byIndex":
      return (index: number) => spec.values[index] ?? spec.fallback;
    case "page":
      return (page: number, total: number) => {
        const template = spec.coverFirst && page === 1 ? spec.cover : spec.page;
        if (template === null) return null;
        const node = structuredClone(template);
        fillPageNumbers(node, page - spec.firstPage, total - spec.firstPage);
        return node;
      };
    case "keepHeadingWithNext":
      // A framed heading (levels 1 and 3) is a one-cell table, and its own
      // cell is among the nodes after it: that one does not count.
      return (
        node: { headlineLevel?: unknown },
        queries: { getFollowingNodesOnPage(): { style?: unknown }[] },
      ) =>
        node.headlineLevel !== undefined &&
        queries
          .getFollowingNodesOnPage()
          .every((next) => FRAMED_HEADING_STYLES.includes(next.style));
  }
}

/** The function `spec` describes, tagged so that it serializes. */
export function pdfFunction<T>(spec: PdfFunctionSpec): T {
  const fn = materialize(spec);
  specs.set(fn, spec);
  return fn as T;
}

/** A table layout whose every entry is a constant. */
export function constantLayout<T extends string>(
  values: Record<T, string | number | boolean | null>,
): Record<T, () => string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      pdfFunction({
        kind: "constant",
        value: value as string | number | boolean | null,
      }),
    ]),
  ) as Record<T, () => string | number | boolean | null>;
}

const LIGATURES = /[\uFB00-\uFB06]/g;

/**
 * `text` with the ligature characters U+FB00-FB06 (ﬀ, ﬁ, ﬂ, ﬃ, ﬄ, ﬅ, ﬆ),
 * common in text pasted from a PDF, spelled out in their letters: the
 * embedded Raleway has no glyph for them and pdfmake would draw a box. Only
 * those: a full NFKC would also change ª, º, ² or ½.
 */
export function expandLigatures(text: string): string {
  return text.replace(LIGATURES, (ligature) => ligature.normalize("NFKC"));
}

/**
 * The hyphen (U+2010) and the non-breaking hyphen (U+2011): Raleway draws
 * neither, so they print as the hyphen-minus it has. The non-breaking one
 * loses its meaning there (accepted, it printed as a box before): pdfmake
 * may break a line after the hyphen-minus, so «2025‑2026» can wrap at it.
 */
const HYPHENS = /[\u2010\u2011]/g;

/** What every string of a definition becomes: letters Raleway draws. */
export function pdfText(text: string): string {
  return expandLigatures(text).replace(HYPHENS, "-");
}

/**
 * The family of Raleway's latin-ext cut (pdfmake.ts registers it next to
 * Raleway): the letters the embedded Raleway, a latin subset, has no glyph
 * for (ć, ł, ő, č, ş...).
 */
export const RALEWAY_EXT_FAMILY = "RalewayExt";

/**
 * The code points the latin-ext cut draws and Raleway does not: the
 * latin-ext unicode-range of @fontsource/raleway, less the few the latin
 * file has too (U+0102, U+0131, U+0152-0153). pdfSerial.test.ts checks it
 * against both files. Raleway has no ≥, ≤ or →: those stay boxes.
 */
const LATIN_EXT_SOURCE =
  "\u0100\u0101\u0103-\u0130\u0132-\u0151\u0154-\u02BA\u02BD-\u02C5\u02C7-\u02CC" +
  "\u02CE-\u02D7\u02DD-\u02FF\u1D00-\u1DBF\u1E00-\u1E9F\u1EF2-\u1EFF\u2020" +
  "\u20A0-\u20AB\u20AD-\u20C0\u2113\u2C60-\u2C7F\uA720-\uA7FF";
export const LATIN_EXT = new RegExp(`[${LATIN_EXT_SOURCE}]`, "u");
const LATIN_EXT_RUNS = new RegExp(`([${LATIN_EXT_SOURCE}]+)`, "u");

type TextRun = string | { text: string; font: string };

/**
 * `text` cut where it switches between Raleway and its latin-ext cut: the
 * plain parts as strings, the others in RALEWAY_EXT_FAMILY. A word cut so
 * («Gda|ń|sk») stays one word on its line, and a justified line opens no
 * space inside it (pdfJustify.ts).
 */
export function latinExtRuns(text: string): TextRun[] {
  return text
    .split(LATIN_EXT_RUNS)
    .map((part, index): TextRun =>
      index % 2 === 1 ? { text: part, font: RALEWAY_EXT_FAMILY } : part,
    )
    .filter((run) => typeof run !== "string" || run.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An inline of a text array, cut into runs (latinExtRuns) that keep its
 * properties: pdfmake drops the properties of an inline whose own `text`
 * is an array, so a bold word must not become one. Only the first run keeps
 * the `id`, a destination named once.
 */
function inlineRuns(inline: unknown): unknown[] {
  if (typeof inline === "string") {
    return LATIN_EXT.test(inline) ? latinExtRuns(inline) : [inline];
  }
  if (
    isPlainObject(inline) &&
    typeof inline.text === "string" &&
    LATIN_EXT.test(inline.text)
  ) {
    const { text, id, ...rest } = inline as { text: string; id?: unknown };
    return latinExtRuns(text).map((run, index) => ({
      ...(index === 0 && id !== undefined ? { id } : {}),
      ...rest,
      ...(typeof run === "string" ? { text: run } : run),
    }));
  }
  return [withLatinExtFont(inline, null)];
}

/**
 * The serialized definition with its letters outside Raleway in its
 * latin-ext cut: a node's `text` string becomes runs, an inline of a text
 * array is cut into inlines (inlineRuns), and a bare string where a node
 * goes (an item of `content`, `stack`, a table row, a list) becomes a node
 * with runs. Strings under any other key (styles, ids, links, metadata) stay
 * as they are. What has nothing to change is returned as it was.
 */
function withLatinExtFont(value: unknown, key: string | null): unknown {
  if (typeof value === "string") {
    if (!LATIN_EXT.test(value)) return value;
    if (key === "text") return latinExtRuns(value);
    return key === null ? { text: latinExtRuns(value) } : value;
  }
  if (Array.isArray(value)) {
    const items =
      key === "text"
        ? value.flatMap(inlineRuns)
        : value.map((item) => withLatinExtFont(item, null));
    return items.length === value.length &&
      items.every((item, index) => item === value[index])
      ? value
      : items;
  }
  if (!isPlainObject(value)) return value;
  let result: Record<string, unknown> | null = null;
  for (const [entryKey, item] of Object.entries(value)) {
    const routed = withLatinExtFont(item, entryKey);
    if (routed === item) continue;
    result ??= { ...value };
    result[entryKey] = routed;
  }
  return result ?? value;
}

function toSerial(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      // Every string pdfmake lays out crosses here, in every PDF.
      return pdfText(value);
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`PDF definition: ${path} is not a finite number`);
      }
      return value;
    case "function": {
      const spec = specs.get(value);
      if (!spec) {
        throw new TypeError(`PDF definition: ${path} is an untagged function`);
      }
      return { [PDF_FUNCTION_KEY]: toSerial(spec, `${path}()`) };
    }
    case "object":
      break;
    default:
      throw new TypeError(`PDF definition: ${path} is a ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === undefined) {
        throw new TypeError(`PDF definition: ${path}[${index}] is undefined`);
      }
      return toSerial(item, `${path}[${index}]`);
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`PDF definition: ${path} is not plain data`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === PDF_FUNCTION_KEY) {
      throw new TypeError(`PDF definition: ${path} uses a reserved key`);
    }
    // JSON leaves an undefined property out, as pdfmake reads it.
    if (item === undefined) continue;
    Object.defineProperty(result, key, {
      value: toSerial(item, `${path}.${key}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * The definition as JSON for the render process. Call it before pdfmake
 * sees the definition: pdfmake writes into the nodes it lays out.
 */
export function serializePdfDefinition(
  definition: TDocumentDefinitions,
): string {
  return JSON.stringify(
    withLatinExtFont(toSerial(definition, "definition"), "definition"),
  );
}

/**
 * The render process's copy of `materialize` and its reviver, as CommonJS
 * source (pdfRender.ts embeds it). Kept in step with the functions above:
 * export.test.ts ("render process") renders the same definition here and
 * there and compares the bytes.
 */
export const PDF_FUNCTIONS_SCRIPT = `
const PDF_FUNCTION_KEY = ${JSON.stringify(PDF_FUNCTION_KEY)};
const PAGE_NUMBER_MARK = String.fromCharCode(${PAGE_NUMBER_MARK.charCodeAt(0)});
const PAGE_TOTAL_MARK = String.fromCharCode(${PAGE_TOTAL_MARK.charCodeAt(0)});
const FRAMED_HEADING_STYLES = ${JSON.stringify(FRAMED_HEADING_STYLES)};
function fillPageNumbers(node, page, total) {
  if (Array.isArray(node)) {
    for (const item of node) fillPageNumbers(item, page, total);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (key === "text" && value === PAGE_NUMBER_MARK) node[key] = String(page);
    else if (key === "text" && value === PAGE_TOTAL_MARK) node[key] = String(total);
    else fillPageNumbers(value, page, total);
  }
}
function materialize(spec) {
  switch (spec.kind) {
    case "constant":
      return () => spec.value;
    case "byIndex":
      return (index) => spec.values[index] ?? spec.fallback;
    case "page":
      return (page, total) => {
        const template = spec.coverFirst && page === 1 ? spec.cover : spec.page;
        if (template === null) return null;
        const node = structuredClone(template);
        fillPageNumbers(node, page - spec.firstPage, total - spec.firstPage);
        return node;
      };
    case "keepHeadingWithNext":
      return (node, queries) =>
        node.headlineLevel !== undefined &&
        queries
          .getFollowingNodesOnPage()
          .every((next) => FRAMED_HEADING_STYLES.includes(next.style));
  }
  throw new Error("unknown PDF function");
}
function parseDefinition(json) {
  return JSON.parse(json, (key, value) =>
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, PDF_FUNCTION_KEY)
      ? materialize(value[PDF_FUNCTION_KEY])
      : value,
  );
}
`;
