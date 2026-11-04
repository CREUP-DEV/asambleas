import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";
import { createError } from "h3";
import JSZip from "jszip";
// mammoth only runs in the converter process, which loads it by path (see
// runConverter). This import keeps it among the server's traced dependencies.
import "mammoth";
import { parseHTML } from "linkedom";
import { createId } from "@paralleldrive/cuid2";
import { z } from "zod/v4";
import type { DocxImportDto } from "../../../shared/types/api";
import { htmlElementToBlocks } from "../../../shared/utils/content/editor";
import { blocksSchema } from "../../../shared/utils/schemas/content";
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
 * The HTML mammoth returns is then capped in bytes and tags before linkedom
 * parses it here (about 0.3 KB of heap per tag). Only one conversion runs at
 * a time, so concurrent uploads cannot multiply the converter's memory.
 *
 * Measured: real CREUP resolutions and consolidated texts (0.4 to 0.8 MB, 200
 * to 600 blocks) convert in about 1 s, process start included, within 48 MB
 * of heap. A dense 3,000-paragraph document (the block limit) with ten
 * formatted runs each, 250,000 elements, needs 256 to 384 MB and 4.5 s. The
 * 150 KB upload above answers 413 after about 7 s, and this process's event
 * loop never stalls for more than about 90 ms.
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
  /** `<` in that HTML (opening and closing tags), parsed again here. */
  maxHtmlTags: number;
}

export const DOCX_LIMITS: DocxLimits = {
  maxEntries: 1_000,
  maxUncompressedBytes: 32 * 1024 * 1024,
  converterHeapMb: 512,
  converterTimeoutMs: 15_000,
  maxHtmlBytes: 8 * 1024 * 1024,
  maxHtmlTags: 300_000,
};

/** Conversions running at once, and waiting for a slot, before a 429. */
const MAX_RUNNING_CONVERSIONS = 1;
const MAX_WAITING_CONVERSIONS = 6;

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const CENTRAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const LESS_THAN = 0x3c;
const NEWLINE = 0x0a;

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

function invalidFile(): never {
  throw invalidFileError();
}

function tooLarge(): never {
  throw tooLargeError();
}

/** A Buffer view over the same memory, without copying. */
function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Occurrences of `byte` in `data`, counting no further than `max + 1`. */
function countByte(data: Uint8Array, byte: number, max: number): number {
  const buffer = asBuffer(data);
  let count = 0;
  for (
    let index = buffer.indexOf(byte);
    index !== -1 && count <= max;
    index = buffer.indexOf(byte, index + 1)
  ) {
    count++;
  }
  return count;
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

function entryData(file: JSZip.JSZipObject): LoadedEntryData {
  const data = (file as unknown as { _data?: LoadedEntryData })._data;
  if (!data || typeof data !== "object") invalidFile();
  return data;
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
  for (const file of entries) declaredTotal += declaredSize(entryData(file));
  // Honest archives over the budget are refused without inflating anything.
  if (declaredTotal > limits.maxUncompressedBytes) tooLarge();

  let remaining = limits.maxUncompressedBytes;
  let documentXml: string | null = null;
  let commentsXml: string | null = null;
  for (const file of entries) {
    const data = entryData(file);
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

/**
 * Runs `task` once fewer than MAX_RUNNING_CONVERSIONS are running, so
 * concurrent imports cannot multiply the converter's memory. Answers 429 when
 * the queue is full. The slot is taken synchronously, before any await.
 */
async function withConversionSlot<T>(task: () => Promise<T>): Promise<T> {
  if (runningConversions < MAX_RUNNING_CONVERSIONS) {
    runningConversions++;
  } else if (waitingConversions.length < MAX_WAITING_CONVERSIONS) {
    // The slot is handed over by the task that releases it.
    await new Promise<void>((resolve) => waitingConversions.push(resolve));
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
 * rejects the file, 500 when the process cannot run at all.
 */
function runConverter(
  data: Buffer,
  limits: DocxLimits,
): Promise<{ html: Buffer; imagesDropped: boolean }> {
  return new Promise((resolve, reject) => {
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
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const abort = (error: Error) => {
      settle(() => reject(error));
      child.kill("SIGKILL");
    };
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

/**
 * Converts a DOCX file to blocks with fresh ids. Throws 415 when the file is
 * not a DOCX, 413 when it is too large, 429 when too many imports are running
 * and 422 when it holds no usable text or exceeds the content limits.
 */
export async function convertDocx(
  data: Buffer,
  limits: DocxLimits = DOCX_LIMITS,
): Promise<DocxImportDto> {
  if (!hasZipSignature(data)) invalidFile();

  const { blocks, warnings } = await withConversionSlot(async () => {
    const { warnings } = await inspectArchive(data, limits);
    const { html, imagesDropped } = await runConverter(data, limits);
    if (imagesDropped) warnings.add("images_dropped");
    if (countByte(html, LESS_THAN, limits.maxHtmlTags) > limits.maxHtmlTags) {
      tooLarge();
    }

    const { document } = parseHTML(
      `<!doctype html><html><body>${html.toString("utf8")}</body></html>`,
    );
    const blocks = htmlElementToBlocks(
      document.body as unknown as Element,
      () => createId(),
    );
    return { blocks, warnings };
  });

  if (blocks.length === 0) {
    throw createError({
      statusCode: 422,
      message: "El documento no contiene texto que se pueda importar",
    });
  }
  const parsed = blocksSchema.safeParse(blocks);
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      message:
        "El documento es demasiado extenso o tiene párrafos demasiado largos",
    });
  }

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
