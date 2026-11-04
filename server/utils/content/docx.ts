import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import { createError } from "h3";
import JSZip from "jszip";
// mammoth only runs in the converter process, which loads it by path (see
// runConverter). This import keeps it among the server's traced dependencies.
import "mammoth";
import { parseHTML } from "linkedom";
import { z } from "zod/v4";
import type { DocxImportDto } from "../../../shared/types/api";
import { htmlElementToBlocks } from "../../../shared/utils/content/editor";
import {
  BLOCK_TEXT_MAX_LENGTH,
  blocksSchema,
  DOCUMENT_MAX_BLOCKS,
} from "../../../shared/utils/schemas/content";
import { logError, logWarn } from "../core/logger";

/**
 * DOCX import: Word file -> sanitized blocks. The file is never stored. Only
 * text, headings, lists, quotes and inline emphasis survive the conversion;
 * htmlElementToBlocks drops everything else and blocksSchema removes unsafe
 * links.
 */

export const DOCX_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Ceilings for one import. Two things make a small upload expensive:
 *
 * - The sizes in a ZIP are declared by whoever wrote it. Every entry is
 *   inflated here first (and discarded) against a budget of real bytes, after
 *   capping the entry count, so neither this process nor mammoth (which reads
 *   the same entries through the same JSZip) inflates more than the budget.
 * - mammoth parses each part it reads into a DOM with @xmldom/xmldom, whose
 *   lenient mode turns markup such as `<w:p a b c/>` or `<w:p a"x"b"y"/>` into
 *   one attribute node per name, and the relationships can make it parse the
 *   same part up to six times. Run in this process, a 150 KB upload took 3 GB
 *   and blocked the event loop for 22 s. No count over the raw bytes bounds
 *   that reliably, so mammoth runs in a separate Node process with its own
 *   heap ceiling and a wall-clock timeout: whatever the markup, it can neither
 *   exhaust this process's memory nor stall its event loop, and running out
 *   answers 413. A worker thread is not enough: when a worker reaches its
 *   resourceLimits, V8 can abort the whole process instead of the worker.
 *
 * The HTML mammoth returns is then parsed with linkedom and walked into blocks
 * here, synchronously: that is the part of an import that still runs on this
 * process's event loop, in three stretches (parsing, walking and validating)
 * with a turn of the loop between them. Before parsing, one pass over the
 * HTML (inspectHtml) bounds what they cost:
 *
 * - the nodes linkedom builds, a text node for every entity included;
 * - the nesting depth;
 * - the elements the walk visits, about 30 µs each with or without text;
 * - the marks that nested formatting multiplies;
 * - the text of each block, since one huge string costs several times more
 *   per byte than many small ones;
 * - the text and nodes the walk reads, counting every read: each row of a
 *   table reads all the cells nested in it again;
 * - the nodes the walk copies to read list items, more the deeper they are.
 *
 * The walk then stops at the first block past the document limit, and block
 * ids come from the system CSPRNG instead of cuid2, whose createId costs about
 * 0.35 ms each.
 *
 * Only one conversion runs at a time, so concurrent uploads cannot multiply
 * the converter's memory, and each user has at most one running or waiting,
 * so nobody can hold the queue. A conversion whose client went away leaves
 * the queue at once, and a running one is stopped.
 *
 * Measured: real CREUP resolutions and consolidated texts (0.4 to 0.8 MB, 200
 * to 600 blocks) convert in about 1 s, process start included, within 48 MB
 * of heap. A dense 3,000-paragraph document (the block limit) with ten
 * formatted runs each, 250,000 elements, needs 256 to 384 MB and 4.5 s in the
 * converter. The 150 KB upload above answers 413 after about 7 s.
 *
 * The longest stretch this process's event loop is then blocked, measured on
 * a development machine with other work running:
 *
 * - 0.2 s for 3,000 plain paragraphs and 0.4 s for a 3,000-row table;
 * - 0.65 to 0.95 s for the largest documents the bounds admit, about 100,000
 *   nodes, such as 3,000 densely formatted paragraphs or list items;
 * - for uploads built against the bounds, each pushing one of them to the
 *   limit, 0.15 to 0.6 s with nested tables, table cells or 6 MB of text,
 *   and 0.85 to 1.35 s with 3,000 list items of 15 line breaks, the worst
 *   case found.
 *
 * Heavier load or a cold process can double these.
 *
 * Before the bounds, 4 to 12 KB files stalled it for 8 to 38 s: 30,000
 * paragraphs, text in ten nested tables, or a paragraph of entities.
 */
export interface DocxLimits {
  /** Entries in the central directory. A Word file holds a few dozen. */
  maxEntries: number;
  /** Real uncompressed bytes of all entries together. */
  maxUncompressedBytes: number;
  /** V8 heap of the converter process, in MB. */
  converterHeapMb: number;
  /** Wall-clock time the converter process may take, in ms. */
  converterTimeoutMs: number;
  /** UTF-8 bytes of HTML the converter may return. */
  maxHtmlBytes: number;
  /**
   * Nodes linkedom builds from that HTML, at 2.5 to 5 µs each: elements, and
   * a text node for every entity (`&amp;`, `&lt;`, `&gt;`) and for every run
   * of text around them. An entity in an attribute value counts as one too.
   */
  maxHtmlNodes: number;
  /**
   * Elements nested inside each other in that HTML. Three nested tables
   * holding a five-level list in bold italic superscript links reach 27.
   */
  maxHtmlDepth: number;
  /**
   * Paragraphs, headings and list items outside tables, plus table rows: the
   * elements the walk visits. Each yields at most one block, but one without
   * text yields none and a footnote takes two (an item and its paragraph).
   */
  maxBlockElements: number;
  /**
   * Marks the walk creates: one per bold, italic, underline, strikethrough or
   * link element around each text node outside tables. Nested links
   * multiply them: 30,000 line breaks inside 26 nested links made 870,000.
   */
  maxMarks: number;
  /**
   * Bytes of text that one block is built from: a paragraph, heading or list
   * item outside tables, or a row of an outermost table with every table
   * nested in it. A block holds at most BLOCK_TEXT_MAX_LENGTH characters;
   * entities and runs of spaces, which collapse, make the HTML longer.
   */
  maxBlockTextBytes: number;
  /**
   * Bytes of text the walk reads, plus NODE_READ_BYTES for each node it
   * visits, counted again every time it reads them: 30 to 50 ns a byte. It
   * reads text and nodes outside tables once, and those in a table nested t
   * deep t(t+1)/2 times: every row of the outermost table reads each cell
   * nested in it. 7 MB of text ten tables deep took 38 s.
   */
  maxWalkReads: number;
  /**
   * Nodes the walk copies to read list items, at about 4 to 7 µs each with
   * the reading. It copies each item with everything nested in it, and each
   * nested list once more, so a node d lists deep is copied 2d - 1 times:
   * 90,000 line breaks five lists deep took 2 to 3.5 s.
   */
  maxListCopies: number;
  /** Blocks the walk may produce; it stops at the first one past this. */
  maxBlocks: number;
}

export const DOCX_LIMITS: DocxLimits = {
  maxEntries: 1_000,
  maxUncompressedBytes: 32 * 1024 * 1024,
  converterHeapMb: 512,
  converterTimeoutMs: 15_000,
  maxHtmlBytes: 8 * 1024 * 1024,
  // 3,000 paragraphs, each with ten bold or italic words among plain text,
  // come to about 93,000; a 3,000-row table of six columns to 57,000.
  maxHtmlNodes: 100_000,
  maxHtmlDepth: 32,
  maxBlockElements: 2 * DOCUMENT_MAX_BLOCKS,
  // Ten runs, bold and italic, in each of 3,000 paragraphs.
  maxMarks: 20 * DOCUMENT_MAX_BLOCKS,
  // Five bytes per character, as if every one were an entity.
  maxBlockTextBytes: 5 * BLOCK_TEXT_MAX_LENGTH,
  // 3,000 densely formatted paragraphs come to 1 MB, 3,000 table rows of six
  // cells to 0.55 MB.
  maxWalkReads: 6 * 1024 * 1024,
  // A list of 3,000 densely formatted items, 93,000 nodes, copies each once.
  maxListCopies: 100_000,
  maxBlocks: DOCUMENT_MAX_BLOCKS,
};

/**
 * What visiting a node costs the walk in bytes of text read, with room to
 * spare: a read of a node in nested tables took 80 to 190 ns, of a byte of
 * text 30 to 50 ns.
 */
const NODE_READ_BYTES = 8;

/** Conversions running at once, and waiting for a slot, before a 429. */
const MAX_RUNNING_CONVERSIONS = 1;
const MAX_WAITING_CONVERSIONS = 6;

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const CENTRAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const AMPERSAND = 0x26;
const NEWLINE = 0x0a;

/** Elements outside tables that htmlElementToBlocks turns into a block. */
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
/** Lists, whose items htmlElementToBlocks copies before reading them. */
const LIST_ELEMENTS = new Set(["ul", "ol"]);
/** Elements htmlElementToBlocks turns into a mark on the text inside them. */
const MARK_ELEMENTS = new Set([
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "strike",
  "a",
]);

/** Block ids shaped like the editor's cuid2 ids: a letter, then base 36. */
const BLOCK_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const BLOCK_ID_LENGTH = 24;

/** JSZip compression magics (lib/compressions.js and lib/flate.js). */
const STORE_MAGIC = "\x00\x00";
const DEFLATE_MAGIC = "\x08\x00";

const DOCUMENT_PART = "word/document.xml";
const COMMENTS_PART = "word/comments.xml";

type DocxWarning = DocxImportDto["warnings"][number];

/** JSZip's internal CompressedObject for an entry read from an archive. */
interface LoadedEntryData {
  compressedContent?: unknown;
  uncompressedSize?: unknown;
  compression?: { magic?: unknown } | null;
}

/** Headings beyond mammoth's defaults (which already map Heading 1-6). */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  // Spanish Word stores built-in heading ids without the accent.
  "p.Ttulo => h1:fresh",
  "p.Ttulo1 => h1:fresh",
  "p.Ttulo2 => h2:fresh",
  "p.Ttulo3 => h3:fresh",
  "p.Ttulo4 => h4:fresh",
  "p.Subttulo => h2:fresh",
];

// <w:ins>, <w:del>, <w:moveFrom>, <w:moveTo>, but not <w:instrText> or <w:delText>.
const TRACKED_CHANGE_PATTERN = /<w:(ins|del|moveFrom|moveTo)[\s>/]/;
const COMMENT_PATTERN = /<w:comment[\s>]/;

/**
 * The converter process (CommonJS, run with `node -e`). It reads the DOCX from
 * stdin, loads mammoth from the path in argv and writes one JSON header line,
 * followed by the HTML when the conversion succeeded. Images are dropped, so
 * they are never read or inlined, and a style map embedded in the file is
 * ignored: only STYLE_MAP decides which elements come out. On Linux it asks
 * to be the first process the kernel kills when memory runs out.
 */
const CONVERTER_SCRIPT = `"use strict";
if (process.platform === "linux") {
  try {
    require("node:fs").writeFileSync("/proc/self/oom_score_adj", "1000");
  } catch {}
}
const [entry, settings] = process.argv.slice(1);
const options = JSON.parse(settings);
const input = [];
function reply(header, body) {
  const head = Buffer.from(JSON.stringify(header) + "\\n", "utf8");
  process.stdout.write(body ? Buffer.concat([head, body]) : head);
}
process.stdin.on("data", (chunk) => input.push(chunk));
process.stdin.on("end", () => {
  let mammoth;
  try {
    mammoth = require(entry);
  } catch {
    reply({ status: "unavailable" });
    return;
  }
  let imagesDropped = false;
  Promise.resolve()
    .then(() =>
      mammoth.convertToHtml(
        { buffer: Buffer.concat(input.splice(0)) },
        {
          styleMap: options.styleMap,
          externalFileAccess: false,
          includeEmbeddedStyleMap: false,
          convertImage: mammoth.images.imgElement(async () => {
            imagesDropped = true;
            return { src: "" };
          }),
        },
      ),
    )
    .then(
      (result) => {
        const html = Buffer.from(result.value, "utf8");
        if (html.length > options.maxHtmlBytes) reply({ status: "too_large" });
        else reply({ status: "ok", imagesDropped }, html);
      },
      () => reply({ status: "invalid" }),
    );
});
`;

const converterHeaderSchema = z.object({
  status: z.enum(["ok", "invalid", "too_large", "unavailable"]),
  imagesDropped: z.boolean().optional(),
});

/** Environment variables the converter process inherits; nothing else. */
const CONVERTER_ENV_KEYS = ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"];

export function hasZipSignature(data: Uint8Array): boolean {
  return ZIP_SIGNATURE.every((byte, index) => data[index] === byte);
}

function invalidFileError() {
  return createError({
    statusCode: 415,
    message: "El archivo no parece ser un documento de Word (.docx) válido",
  });
}

function tooLargeError() {
  return createError({
    statusCode: 413,
    message: "El documento es demasiado grande para importarlo",
  });
}

function converterFailedError() {
  return createError({
    statusCode: 500,
    message: "No se ha podido convertir el documento",
  });
}

function tooExtensiveError() {
  return createError({
    statusCode: 422,
    message:
      "El documento es demasiado extenso o tiene párrafos demasiado largos",
  });
}

/**
 * The client went away. Nobody receives this answer; 499 is the status
 * proxies log for a request the client closed.
 */
function cancelledError() {
  return createError({
    statusCode: 499,
    message: "La importación se ha cancelado",
  });
}

function invalidFile(): never {
  throw invalidFileError();
}

function tooLarge(): never {
  throw tooLargeError();
}

function tooExtensive(): never {
  throw tooExtensiveError();
}

/** A Buffer view over the same memory, without copying. */
function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** The lowercase ASCII name of the tag whose name starts at `start`. */
function tagName(html: Buffer, start: number): string {
  let end = start;
  while (end < html.length && end - start < 16) {
    const byte = html[end]!;
    const isNameByte =
      (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39);
    if (!isNameByte) break;
    end++;
  }
  return html.toString("latin1", start, end);
}

/**
 * Times the walk reads a node or text inside `tables` nested tables. The
 * outermost table reads each of its rows, nested ones included, and each row
 * the text of every cell inside it, so text t tables deep is read once by
 * each of the t rows around it for each of the cells between that row and
 * the text: t(t+1)/2 times.
 */
function readsAt(tables: number): number {
  return tables === 0 ? 1 : (tables * (tables + 1)) / 2;
}

/**
 * Bounds the work of parsing and walking the converter's HTML, in one pass
 * before linkedom sees it: 413 past `maxHtmlNodes`, 422 past any other limit
 * on the HTML. mammoth writes balanced markup and escapes `<`, `>` and `&` in
 * text and attribute values, so every `<` starts a tag, `</` closes the
 * innermost open element, the first `>` ends the tag, `/>` marks one with no
 * content, such as `<br />`, and every `&` starts an entity.
 */
function inspectHtml(html: Buffer, limits: DocxLimits): void {
  let nodes = 0;
  let depth = 0;
  let tables = 0;
  // Lists open outside tables: the walk copies what is inside them.
  let lists = 0;
  let blockElements = 0;
  // Mark elements open around the current text, and the marks the walk will
  // create from them: one per open mark element for each text node.
  let markElements = 0;
  let marks = 0;
  let blockText = 0;
  let walkReads = 0;
  let listCopies = 0;

  const addReads = (bytes: number) => {
    walkReads += readsAt(tables) * bytes;
    if (walkReads > limits.maxWalkReads) tooExtensive();
  };
  const addNodes = (count: number) => {
    nodes += count;
    if (nodes > limits.maxHtmlNodes) tooLarge();
    addReads(NODE_READ_BYTES * count);
    if (lists > 0) {
      listCopies += (2 * lists - 1) * count;
      if (listCopies > limits.maxListCopies) tooExtensive();
    }
  };
  // The next `&` not yet counted. It only moves forward, so counting the
  // entities of every run of text and every tag scans the HTML once.
  let nextEntity = html.indexOf(AMPERSAND);
  const entitiesBefore = (end: number) => {
    let count = 0;
    while (nextEntity !== -1 && nextEntity < end) {
      count++;
      nextEntity = html.indexOf(AMPERSAND, nextEntity + 1);
    }
    return count;
  };
  const readText = (start: number, end: number) => {
    // linkedom makes a text node of each entity and of each run of text
    // between them: `a &amp; b` is three.
    const textNodes = 2 * entitiesBefore(end) + 1;
    addNodes(textNodes);
    addReads(end - start);
    blockText += end - start;
    if (blockText > limits.maxBlockTextBytes) tooExtensive();
    // Text in table cells is read whole, without marks.
    if (markElements > 0 && tables === 0) {
      marks += markElements * textNodes;
      if (marks > limits.maxMarks) tooExtensive();
    }
  };

  let textStart = 0;
  let index = html.indexOf(LESS_THAN);
  while (index !== -1) {
    if (index > textStart) readText(textStart, index);
    const end = html.indexOf(GREATER_THAN, index);
    if (end === -1) invalidFile();
    // Entities in attribute values are decoded while parsing; each counts
    // as a node.
    const attributeEntities = entitiesBefore(end);
    if (attributeEntities > 0) addNodes(attributeEntities);
    if (html[index + 1] === SLASH) {
      depth--;
      const name = tagName(html, index + 2);
      if (name === "table") tables--;
      else if (tables === 0 && LIST_ELEMENTS.has(name)) lists--;
      else if (MARK_ELEMENTS.has(name)) markElements--;
    } else {
      addNodes(1);
      const name = tagName(html, index + 1);
      const isBlock = tables === 0 && BLOCK_ELEMENTS.has(name);
      // Rows of nested tables count too: the outer table's walk visits them.
      if (name === "tr" || isBlock) {
        if (++blockElements > limits.maxBlockElements) tooExtensive();
      }
      // A block's text starts at its element, or at a row of the outermost
      // table, which takes in everything nested in it.
      if (isBlock || (name === "tr" && tables === 1)) blockText = 0;
      // An element with no content (`<br />`) opens nothing.
      if (html[end - 1] !== SLASH) {
        if (++depth > limits.maxHtmlDepth) tooExtensive();
        if (name === "table") tables++;
        else if (tables === 0 && LIST_ELEMENTS.has(name)) lists++;
        else if (MARK_ELEMENTS.has(name)) markElements++;
      }
    }
    textStart = end + 1;
    index = html.indexOf(LESS_THAN, textStart);
  }
  // linkedom keeps text after the last tag too, though the walk ignores it.
  if (html.length > textStart) readText(textStart, html.length);
}

/**
 * A fresh block id: a lowercase letter and 23 lowercase letters or digits,
 * like the cuid2 ids the editor mints, from the system CSPRNG. The modulo
 * bias leaves more than 120 bits of entropy. cuid2's createId costs about
 * 0.35 ms each, which for 3,000 blocks held the event loop for a second.
 */
function newBlockId(): string {
  const bytes = randomBytes(BLOCK_ID_LENGTH);
  let id = BLOCK_ID_ALPHABET[bytes[0]! % 26]!;
  for (let index = 1; index < BLOCK_ID_LENGTH; index++) {
    id += BLOCK_ID_ALPHABET[bytes[index]! % BLOCK_ID_ALPHABET.length]!;
  }
  return id;
}

/**
 * Upper bound on the entries JSZip will read: each central directory record
 * starts with this signature, so there cannot be more records than matches.
 * Checked before JSZip parses the archive, whose cost grows with the count.
 */
function exceedsEntryLimit(data: Buffer, maxEntries: number): boolean {
  let count = 0;
  for (
    let index = data.indexOf(CENTRAL_FILE_HEADER);
    index !== -1;
    index = data.indexOf(CENTRAL_FILE_HEADER, index + 1)
  ) {
    if (++count > maxEntries) return true;
  }
  return false;
}

/**
 * JSZip's CompressedObject for an entry, or null for an entry whose headers
 * declare it empty. For those JSZip discards the stored bytes, whatever they
 * are, and keeps a promise of an empty string instead (lib/object.js,
 * `isCompressedEmpty`), so neither this process nor mammoth, which reads the
 * archive through the same JSZip, ever inflates them. Word does not write
 * empty parts, but other generators and re-zipping tools do.
 */
function entryData(file: JSZip.JSZipObject): LoadedEntryData | null {
  const data = (file as unknown as { _data?: unknown })._data;
  if (!data || typeof data !== "object") invalidFile();
  if (typeof (data as { then?: unknown }).then === "function") return null;
  return data as LoadedEntryData;
}

function declaredSize(data: LoadedEntryData): number {
  const size = data.uncompressedSize;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    invalidFile();
  }
  return size;
}

/**
 * The real content of an entry, inflating at most `budget` bytes. Answers 413
 * past the budget and 415 for corrupt data or an unknown method.
 */
function realContent(data: LoadedEntryData, budget: number): Uint8Array {
  const content = data.compressedContent;
  if (!(content instanceof Uint8Array)) invalidFile();
  const magic = data.compression?.magic;
  if (magic === STORE_MAGIC) {
    if (content.byteLength > budget) tooLarge();
    return content;
  }
  if (magic !== DEFLATE_MAGIC) invalidFile();
  try {
    // maxOutputLength must be positive; a non-empty entry with no budget left
    // still fails the size check below.
    return inflateRawSync(content, { maxOutputLength: Math.max(budget, 1) });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      tooLarge();
    }
    invalidFile();
  }
}

/**
 * Inflates every entry with the budget in `limits` before anything else reads
 * the archive, and returns the main document and comments parts. An entry
 * whose real size differs from the declared one is refused: JSZip, and so
 * mammoth, would fail on it after inflating it whole.
 */
function inspectEntries(
  zip: JSZip,
  limits: DocxLimits,
): { documentXml: string; commentsXml: string | null } {
  const entries = Object.values(zip.files).filter((file) => !file.dir);

  let declaredTotal = 0;
  for (const file of entries) {
    const data = entryData(file);
    if (data) declaredTotal += declaredSize(data);
  }
  // Honest archives over the budget are refused without inflating anything.
  if (declaredTotal > limits.maxUncompressedBytes) tooLarge();

  let remaining = limits.maxUncompressedBytes;
  let documentXml: string | null = null;
  let commentsXml: string | null = null;
  for (const file of entries) {
    const data = entryData(file);
    // Declared empty: nothing to inflate, and an empty main part is refused
    // below as a missing one.
    if (!data) continue;
    const content = realContent(data, remaining);
    if (content.byteLength > remaining) tooLarge();
    if (content.byteLength !== declaredSize(data)) invalidFile();
    remaining -= content.byteLength;

    if (file.name === DOCUMENT_PART) {
      documentXml = asBuffer(content).toString("utf8");
    } else if (file.name === COMMENTS_PART) {
      commentsXml = asBuffer(content).toString("utf8");
    }
  }
  if (documentXml === null) invalidFile();
  return { documentXml, commentsXml };
}

async function inspectArchive(
  data: Buffer,
  limits: DocxLimits,
): Promise<{ warnings: Set<DocxWarning> }> {
  if (exceedsEntryLimit(data, limits.maxEntries)) tooLarge();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    invalidFile();
  }
  if (!zip.file(DOCUMENT_PART)) invalidFile();
  const { documentXml, commentsXml } = inspectEntries(zip, limits);

  const warnings = new Set<DocxWarning>();
  if (TRACKED_CHANGE_PATTERN.test(documentXml)) warnings.add("tracked_changes");
  if (commentsXml !== null && COMMENT_PATTERN.test(commentsXml)) {
    warnings.add("comments");
  }
  return { warnings };
}

let runningConversions = 0;
const waitingConversions: (() => void)[] = [];
/** Users with a conversion running or waiting. */
const conversionOwners = new Set<string>();

/**
 * Waits until a finishing conversion hands this one its slot. When `signal`
 * aborts first, the conversion leaves the queue at once, frees `owner` to
 * import again and answers 499.
 */
function waitForSlot(owner: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const position = waitingConversions.indexOf(handOver);
      if (position !== -1) waitingConversions.splice(position, 1);
      conversionOwners.delete(owner);
      reject(cancelledError());
    };
    // Called once this waiter has been taken off the queue.
    const handOver = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    waitingConversions.push(handOver);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `task` once fewer than MAX_RUNNING_CONVERSIONS are running, so
 * concurrent imports cannot multiply the converter's memory. Answers 429 when
 * `owner` already has a conversion running or waiting, so one user cannot
 * hold the queue, and when the queue is full; 499 when `signal` aborts before
 * the task starts. The slot is taken synchronously, before any await.
 */
async function withConversionSlot<T>(
  owner: string,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw cancelledError();
  if (conversionOwners.has(owner)) {
    throw createError({
      statusCode: 429,
      message: "Ya tienes una importación en curso; espera a que termine",
    });
  }
  if (runningConversions < MAX_RUNNING_CONVERSIONS) {
    runningConversions++;
    conversionOwners.add(owner);
  } else if (waitingConversions.length < MAX_WAITING_CONVERSIONS) {
    conversionOwners.add(owner);
    // The slot is handed over by the task that releases it.
    await waitForSlot(owner, signal);
  } else {
    throw createError({
      statusCode: 429,
      message:
        "Hay demasiadas importaciones en curso; inténtalo de nuevo en unos segundos",
    });
  }
  try {
    return await task();
  } finally {
    conversionOwners.delete(owner);
    const next = waitingConversions.shift();
    if (next) next();
    else runningConversions--;
  }
}

let mammothEntry: string | undefined;

function converterEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CONVERTER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Converts the DOCX to HTML with mammoth in a separate Node process limited
 * to `converterHeapMb` of heap and `converterTimeoutMs` of wall clock. The
 * process gets neither NODE_OPTIONS nor this process's flags or secrets. 413
 * when it runs out of heap or time or returns too much HTML, 415 when mammoth
 * rejects the file, 500 when the process cannot run at all. When
 * `abortSignal` aborts, the process is killed and the conversion answers 499.
 */
function runConverter(
  data: Buffer,
  limits: DocxLimits,
  abortSignal?: AbortSignal,
): Promise<{ html: Buffer; imagesDropped: boolean }> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(cancelledError());
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      mammothEntry ??= createRequire(import.meta.url).resolve("mammoth");
      child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${limits.converterHeapMb}`,
          "-e",
          CONVERTER_SCRIPT,
          mammothEntry,
          JSON.stringify({
            styleMap: STYLE_MAP,
            maxHtmlBytes: limits.maxHtmlBytes,
          }),
        ],
        {
          env: converterEnv(),
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch (error) {
      logError("docx.converter", error);
      reject(converterFailedError());
      return;
    }

    const output: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(
      () => abort(tooLargeError()),
      limits.converterTimeoutMs,
    );
    const onAbort = () => abort(cancelledError());
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      action();
    };
    const abort = (error: Error) => {
      settle(() => reject(error));
      child.kill("SIGKILL");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      logError("docx.converter", error);
      abort(converterFailedError());
    });
    // The process may exit before reading all of stdin (out of heap, say);
    // its exit decides the outcome, so a broken pipe is not an error here.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      // The header line is a few dozen bytes.
      if (received > limits.maxHtmlBytes + 1024) {
        abort(tooLargeError());
        return;
      }
      output.push(chunk);
    });
    child.on("close", (code, signal) => {
      settle(() => {
        const bytes = Buffer.concat(output);
        const newline = bytes.indexOf(NEWLINE);
        let header: z.infer<typeof converterHeaderSchema> | null = null;
        if (newline !== -1) {
          try {
            const parsed = converterHeaderSchema.safeParse(
              JSON.parse(bytes.subarray(0, newline).toString("utf8")),
            );
            if (parsed.success) header = parsed.data;
          } catch {
            header = null;
          }
        }
        if (header?.status === "ok" && code === 0) {
          resolve({
            html: bytes.subarray(newline + 1),
            imagesDropped: header.imagesDropped === true,
          });
        } else if (header?.status === "invalid") {
          reject(invalidFileError());
        } else if (header?.status === "unavailable") {
          logError("docx.converter", new Error("mammoth could not be loaded"));
          reject(converterFailedError());
        } else {
          // No answer: almost always the heap ceiling, which aborts the process.
          if (!header) logWarn("docx.converter", { code, signal });
          reject(tooLargeError());
        }
      });
    });

    child.stdin?.end(data);
  });
}

/** Lets the event loop run whatever is waiting, timers and I/O included. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ConvertDocxOptions {
  /** The user importing: each may have one conversion running or waiting. */
  owner: string;
  /**
   * Aborts when the client goes away: a queued conversion then leaves the
   * queue and a running one stops, answering 499.
   */
  signal?: AbortSignal;
  limits?: DocxLimits;
}

/**
 * Converts a DOCX file to blocks with fresh ids. Throws 415 when the file is
 * not a DOCX, 413 when it is too large, 429 when the user already has an
 * import running or too many are, and 422 when it holds no usable text or
 * exceeds the content limits.
 */
export async function convertDocx(
  data: Buffer,
  { owner, signal, limits = DOCX_LIMITS }: ConvertDocxOptions,
): Promise<DocxImportDto> {
  if (!hasZipSignature(data)) invalidFile();

  const { blocks, warnings } = await withConversionSlot(
    owner,
    signal,
    async () => {
      // Aborted between being handed the slot and starting.
      if (signal?.aborted) throw cancelledError();
      const { warnings } = await inspectArchive(data, limits);
      const { html, imagesDropped } = await runConverter(data, limits, signal);
      if (imagesDropped) warnings.add("images_dropped");
      inspectHtml(html, limits);

      const { document } = parseHTML(
        `<!doctype html><html><body>${html.toString("utf8")}</body></html>`,
      );
      // Parsing, walking and validating each block the event loop; a turn
      // between them lets other requests through.
      await nextTurn();
      if (signal?.aborted) throw cancelledError();
      let produced = 0;
      const blocks = htmlElementToBlocks(
        document.body as unknown as Element,
        () => {
          // Stops the walk at the first block past the limit.
          if (++produced > limits.maxBlocks) tooExtensive();
          return newBlockId();
        },
      );
      return { blocks, warnings };
    },
  );

  await nextTurn();
  if (blocks.length === 0) {
    throw createError({
      statusCode: 422,
      message: "El documento no contiene texto que se pueda importar",
    });
  }
  const parsed = blocksSchema.safeParse(blocks);
  if (!parsed.success) tooExtensive();

  const order: DocxWarning[] = [
    "tracked_changes",
    "comments",
    "images_dropped",
  ];
  return {
    blocks: parsed.data,
    warnings: order.filter((warning) => warnings.has(warning)),
  };
}
