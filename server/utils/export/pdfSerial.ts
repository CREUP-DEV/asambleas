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
    case "page":
      return (page: number, total: number) => {
        const template = spec.coverFirst && page === 1 ? spec.cover : spec.page;
        if (template === null) return null;
        const node = structuredClone(template);
        fillPageNumbers(node, page - spec.firstPage, total - spec.firstPage);
        return node;
      };
    case "keepHeadingWithNext":
      return (
        node: { headlineLevel?: unknown },
        queries: { getFollowingNodesOnPage(): unknown[] },
      ) =>
        node.headlineLevel !== undefined &&
        queries.getFollowingNodesOnPage().length === 0;
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

function toSerial(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
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
  return JSON.stringify(toSerial(definition, "definition"));
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
        queries.getFollowingNodesOnPage().length === 0;
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
